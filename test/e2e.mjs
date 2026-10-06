'use strict';
/* ===========================================================================
   RoomTalk · 端到端测试（双真浏览器）
   ---------------------------------------------------------------------------
   为什么非要真浏览器：P2P 的问题几乎全在「两端交互」里 —— 协商竞态、
   轨道方向、重连时序。这些在单进程里模拟不出来。

   前提：本地服务已启动（npx wrangler dev，默认 8787）。

   本机特有的三个坑（都已绕开）：
     · 系统代理会劫持 127.0.0.1  → Chrome 加 --no-proxy-server，
       Node 侧清掉 http_proxy 环境变量
     · Chrome 是「启动器即退」，spawn 出来的进程早期就退出，
       真正的浏览器还活着 → 必须走 CDP 的 Browser.close，不能用 proc.kill()
     · 常规位置没有 Chrome → 用 E:\softs\... 那一份

   运行：node test/e2e.mjs
   =========================================================================== */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 本机代理会劫持 localhost，先把环境变量摘干净
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const CHROME = 'E:/softs/Chrome153_AllNew_2026.9.12/App/chrome.exe';
const ORIGIN = process.env.RT_ORIGIN || 'http://127.0.0.1:8787';
const PASSPHRASE = 'e2e-' + Math.random().toString(36).slice(2, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('   \u2713 ' + name); }
  else { fail++; console.log('   \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
}
const section = (t) => console.log('\n== ' + t + ' ==');

/* ------------------------------ CDP 客户端 ------------------------------ */

class Page {
  constructor(name) { this.name = name; this.seq = 0; this.pending = new Map(); }

  async attach(port, profileDir) {
    const proc = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-features=Translate,MediaRouter',
      '--ignore-certificate-errors',
      // ⚠ 千万不要加 --no-proxy-server：实测这一份 Chrome（153）加上它就直接
      //   启动即退、调试端口根本不监听，而且没有任何报错。Chrome 本来就会绕过
      //   localhost 的系统代理，不需要这个参数。
      '--use-fake-ui-for-media-stream',               // 自动授权摄像头/麦克风
      '--use-fake-device-for-media-stream',           // 合成音视频，不需要真设备
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=430,900',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ], { stdio: 'ignore' });
    this.proc = proc;
    this.port = port;

    const target = await this._findTarget(port);
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('无法连接 CDP'));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    };

    await this.send('Page.enable');
    await this.send('Runtime.enable');
    // ⚠ 必须关掉 HTTP 缓存。静态资源带 Cache-Control: max-age=600，
    //   否则改完代码重跑测试，浏览器会拿旧 app.js —— 表现为「新功能测不到」，
    //   而服务端明明是新内容，极其误导。（真踩过。）
    await this.send('Network.enable');
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    await this.send('Page.navigate', { url: ORIGIN });
    await this.waitReady();
    return this;
  }

  async _findTarget(port) {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await r.json();
        const p = list.find((t) => t.type === 'page');
        if (p?.webSocketDebuggerUrl) return p;
      } catch { /* 还没起来 */ }
      await sleep(200);
    }
    throw new Error('Chrome 未能就绪（port ' + port + '）');
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' :: ' +
        (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  }

  /** 轮询直到页面脚本就绪（命令行传 URL 是异步导航，立刻 evaluate 只会拿到空白文档） */
  async waitReady() {
    for (let i = 0; i < 80; i++) {
      const ok = await this.eval(
        'document.readyState === "complete" && !!window.__rt && !!document.getElementById("passphrase")',
      ).catch(() => false);
      if (ok) return;
      await sleep(200);
    }
    throw new Error('页面未就绪');
  }

  async enter(passphrase) {
    return this.eval(`(() => {
      const p = document.getElementById('passphrase');
      p.value = ${JSON.stringify(passphrase)};
      document.getElementById('gate-form').dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`);
  }

  async type(text) {
    return this.eval(`(() => {
      document.getElementById('text').value = ${JSON.stringify(text)};
      document.getElementById('composer').dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`);
  }

  async click(id) { return this.eval(`document.getElementById(${JSON.stringify(id)}).click(), true`); }

  /** 改画质下拉并触发 change —— 模拟用户伸手去拨那一档 */
  async setQuality(tier) {
    return this.eval(`(() => {
      const s = document.getElementById('video-quality');
      if (!s) return null;
      s.value = ${JSON.stringify(tier)};
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value;
    })()`);
  }

  /** 用 CDP 的 Browser.close 优雅退出 —— Chrome 的启动器进程早已退出，kill 不到真身 */
  async close() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
      const info = await r.json();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((res) => { ws.onopen = res; ws.onerror = res; setTimeout(res, 1500); });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(400);
    } catch { /* 已经没了 */ }
    try { this.ws.close(); } catch { /* noop */ }
    try { this.proc.kill(); } catch { /* 启动器早已退出 */ }
  }
}

async function waitUntil(fn, label, timeout = 25000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(200);
  }
  throw new Error(`等待超时：${label}（最后：${JSON.stringify(last)}）`);
}

/* ------------------------------ 主流程 ------------------------------ */

const tmpRoot = mkdtempSync(join(tmpdir(), 'rt-e2e-'));
const pages = [];

async function cleanup() {
  for (const p of pages) await p.close();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
}

async function main() {
  console.log('口令：' + PASSPHRASE + '    站点：' + ORIGIN);

  // 先把可能残留的浏览器赶走，否则会看到「幽灵设备」
  for (const port of [9222, 9223, 9224]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await r.json();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((res) => { ws.onopen = res; ws.onerror = res; setTimeout(res, 1000); });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(300);
    } catch { /* 没人在听，正常 */ }
  }

  /* ---------------------------- 1. 各自进房 ---------------------------- */
  section('1. 两个人凭同一口令进同一间房');

  const A = await new Page('A').attach(9222, join(tmpRoot, 'a'));
  pages.push(A);
  const B = await new Page('B').attach(9223, join(tmpRoot, 'b'));
  pages.push(B);

  check('首屏就是输入口令（无多余元素）',
    await A.eval('!document.getElementById("gate").hidden && document.getElementById("room").hidden'));

  await A.enter(PASSPHRASE);
  await waitUntil(async () => (await A.eval('__rt.status')).includes('等待对方'), 'A 进房', 15000);
  check('A 进入后显示「等待对方接入」', true);

  await B.enter(PASSPHRASE);
  await waitUntil(async () => (await A.eval('__rt.status')).includes('已连接'), 'A 端接通', 25000);
  await waitUntil(async () => (await B.eval('__rt.status')).includes('已连接'), 'B 端接通', 25000);
  check('两端自动接通（无需任何额外操作）', true);

  const roomA = await A.eval('__rt.room');
  const roomB = await B.eval('__rt.room');
  check('同一口令派生同一房间号', roomA === roomB && /^[0-9a-f]{32}$/.test(roomA), { roomA, roomB });
  check('房间号不含口令原文', !roomA.includes(PASSPHRASE));
  check('双方拿到同一个对端', await A.eval('__rt.remotePeerId') === await B.eval('__rt.peerId'));
  check('数据通道已打开', await A.eval('__rt.dcOpen') && await B.eval('__rt.dcOpen'));
  check('底层是真正的 P2P 连接', await A.eval('__rt.connectionState') === 'connected');

  // 身份核对：纯口令没法证明「你是这个人」，所以必须如实告诉用户这是第一次
  await waitUntil(async () => A.eval('__rt.trustShown'), 'A 收到身份提示', 12000);
  check('首次通话被明确标注为「第一次」（不假装已经认证过）',
    (await A.eval('__rt.trustClass')).includes('new'), await A.eval('__rt.trustClass'));
  check('双方交换到了对方的设备标识',
    !!(await A.eval('__rt.peerDeviceId')) && !!(await B.eval('__rt.peerDeviceId')));
  check('两端设备标识不同', await A.eval('__rt.peerDeviceId') !== await B.eval('__rt.peerDeviceId'));

  /* ---------------------------- 2. 文字 ---------------------------- */
  section('2. 文字');

  await A.type('你好，这是暗号里的第一句话');
  await waitUntil(async () => (await B.eval('__rt.messages')).some((m) => m.text === '你好，这是暗号里的第一句话'), 'B 收到 A 的消息');
  check('A → B 实时送达', true);

  await B.type('收到了。中文、emoji 🎈 一起测');
  await waitUntil(async () => (await A.eval('__rt.messages')).some((m) => m.text === '收到了。中文、emoji 🎈 一起测'), 'A 收到 B 的消息');
  check('B → A 实时送达（含 emoji）', true);

  // 走的是 DataChannel，不是服务器转发 —— 这决定了「服务器不经手内容」
  const aMsgs = await A.eval('__rt.messages');
  check('自己发的记在右侧、对方的记在左侧',
    aMsgs.find((m) => m.text.startsWith('你好'))?.who === 'me' &&
    aMsgs.find((m) => m.text.startsWith('收到了'))?.who === 'them', aMsgs);

  /* ---------------------------- 3. 通话 ---------------------------- */
  section('3. 语音与视频');

  await A.click('btn-cam');
  await waitUntil(async () => (await B.eval('__rt.remoteVideoTracks')) > 0, 'B 收到 A 的视频轨道', 25000);
  check('A 开摄像头 → B 收到视频轨道', true);
  check('B 侧界面显示视频区', await B.eval('!document.getElementById("stage").hidden'));
  check('B 侧标记「对方已开摄像头」', await B.eval('__rt.remoteMedia.video === true'));

  await B.click('btn-mic');
  await waitUntil(async () => (await A.eval('__rt.remoteAudioTracks')) > 0, 'A 收到 B 的音频轨道', 25000);
  check('B 开麦克风 → A 收到音频轨道', true);
  check('A 侧标记「对方已开麦克风」', await A.eval('__rt.remoteMedia.audio === true'));

  check('双向媒体共存（A 出视频、B 出音频）',
    (await B.eval('__rt.remoteVideoTracks')) > 0 && (await A.eval('__rt.remoteAudioTracks')) > 0);

  /* --- 码率与降级偏好：决定「弱网下是掉画质还是掉流畅」的两个参数 --- */
  const vs = await A.eval('__rt.videoStats()');
  check('默认档位是「流畅」', vs.quality === 'smooth', vs.quality);
  check('视频发送端已设码率上限（不会把上行打满）',
    vs.maxBitrate === 600000, vs.maxBitrate);
  check('降级偏好 = 保帧率（带宽不够时降分辨率、不丢帧）',
    vs.degradationPreference === 'maintain-framerate', vs.degradationPreference);
  check('采集端采 720p（再往下压交给编码前缩放，切档才能瞬时生效）',
    vs.captureHeight > 0 && vs.captureHeight <= 720, { w: vs.captureWidth, h: vs.captureHeight });
  check('视频确实在持续出帧（不是黑屏或停帧）', vs.fps > 0, { fps: vs.fps, sent: vs.bytesSent });
  check('受限原因可归因（none / bandwidth / cpu）',
    typeof vs.qualityLimitation === 'string', vs.qualityLimitation);

  /* --- 用户自选画质：切档必须瞬时生效，不能重新协商、不能黑屏 --- */
  const connBefore = await A.eval('__rt.connectionState');
  const dcBefore = await A.eval('__rt.dcOpen');

  await A.setQuality('saver');
  const qSaver = await waitUntil(async () => {
    const s = await A.eval('__rt.videoStats()');
    return s.maxBitrate === 300000 ? s : null;
  }, '「省流量」档生效', 8000);
  check('切到「省流量」：上限降到 300 kbps', qSaver.maxBitrate === 300000, qSaver.maxBitrate);
  check('切到「省流量」：同时把编码分辨率压到 1/2',
    qSaver.scaleResolutionDownBy === 2, qSaver.scaleResolutionDownBy);

  await A.setQuality('sharp');
  const qSharp = await waitUntil(async () => {
    const s = await A.eval('__rt.videoStats()');
    return s.maxBitrate === 1200000 ? s : null;
  }, '「清晰」档生效', 8000);
  check('切到「清晰」：上限提到 1.2 Mbps', qSharp.maxBitrate === 1200000, qSharp.maxBitrate);
  check('切到「清晰」：编码分辨率回到 1:1（不再缩小）',
    qSharp.scaleResolutionDownBy === 1, qSharp.scaleResolutionDownBy);

  check('切档全程没有打断连接（无需重新协商）',
    (await A.eval('__rt.connectionState')) === connBefore
    && (await A.eval('__rt.dcOpen')) === dcBefore
    && connBefore === 'connected',
    { before: connBefore, after: await A.eval('__rt.connectionState') });
  check('切档后仍在持续出帧（画面没有黑掉）',
    (await A.eval('__rt.videoStats()')).fps > 0);

  await A.setQuality('smooth');
  const qBack = await waitUntil(async () => {
    const s = await A.eval('__rt.videoStats()');
    return s.maxBitrate === 600000 ? s : null;
  }, '切回「流畅」', 8000);
  check('切回「流畅」：上限回到 600 kbps', qBack.maxBitrate === 600000, qBack.maxBitrate);

  // 让编码器实跑 3 秒，量真正吐出去的上行码率 —— 这才是「限码率会不会掉流畅」的实测答案
  const v1 = await A.eval('__rt.videoStats()');
  await sleep(3000);
  const v2 = await A.eval('__rt.videoStats()');
  const kbps = Math.round(((v2.bytesSent - v1.bytesSent) * 8) / 3 / 1000);
  console.log(`     实测 3 秒：上行 ${kbps} kbps · ${v2.width}x${v2.height} @ ${v2.fps}fps`
    + ` · 采集 ${v2.captureWidth}x${v2.captureHeight} · 受限原因 ${v2.qualityLimitation}`);
  check('实测上行码率确实在上限之内',
    kbps > 0 && kbps <= vs.maxBitrate / 1000 + 60, { kbps, cap: vs.maxBitrate / 1000 });

  check('对方收到了我的画质档位（免得以为是自己的问题）',
    await waitUntil(async () => (await B.eval('__rt.remoteQuality')) === 'smooth', 'B 收到档位', 8000)
      .then(() => true).catch(() => false));

  await A.click('btn-cam');
  await waitUntil(async () => (await A.eval('__rt.media.video')) === false, 'A 关闭摄像头');
  check('关摄像头后本端状态同步', await A.eval('__rt.media.video') === false);
  check('关摄像头后向对端广播了新状态', await waitUntil(async () => (await B.eval('__rt.remoteMedia.video')) === false, 'B 收到关闭状态', 8000).then(() => true).catch(() => false));

  /* ---------------------------- 4. 第三个人 ---------------------------- */
  section('4. 第三人持同一口令也进不来');

  const C = await new Page('C').attach(9224, join(tmpRoot, 'c'));
  pages.push(C);
  await C.enter(PASSPHRASE);

  const cRoom = await waitUntil(async () => {
    const r = await C.eval('__rt.room');
    return r || null;
  }, 'C 派生房间号', 10000);
  check('C 确实拿着同一个口令（房间号一致）', cRoom === roomA, { cRoom, roomA });

  const wasRejected = await waitUntil(async () => {
    const st = await C.eval('({ gate: !document.getElementById("gate").hidden, room: !document.getElementById("room").hidden })');
    return st.gate && !st.room;
  }, 'C 被退回入口', 12000).then(() => true).catch(() => false);
  check('C 被拒并退回入口（房间上限就是 2）', wasRejected);

  const cErr = await C.eval('document.getElementById("gate-error").textContent');
  check('拒绝理由给出了两条出路，而不是含糊的「进不去」',
    /换/.test(cErr) && /等/.test(cErr), cErr);

  check('通话中的两端不受第三人影响',
    await A.eval('__rt.connectionState') === 'connected' &&
    await B.eval('__rt.connectionState') === 'connected');

  /* ---------------------------- 5. 断线重连 ---------------------------- */
  section('5. 掉线后自动重连并恢复通话');

  // 先在 A 上开着麦克风：重连后它必须自动接回新连接（这一步最容易漏）
  await A.click('btn-mic');
  await waitUntil(async () => (await A.eval('__rt.media.audio')) === true, 'A 打开麦克风', 15000);
  check('重连前 A 正开着麦克风', true);

  // 掐掉 B 的信令连接，模拟网络抖动 / 切基站
  await B.eval('window.__rt.__dropSocket(), true');
  await waitUntil(async () => (await B.eval('__rt.status')).includes('重连'), 'B 进入重连状态', 10000);
  check('B 检测到掉线并自动重连', true);

  await waitUntil(async () => (await B.eval('__rt.status')).includes('已连接'), 'B 重新接通', 30000);
  await waitUntil(async () => (await A.eval('__rt.status')).includes('已连接'), 'A 侧恢复', 30000);
  check('两端自动恢复连接，无需用户操作', true);

  await B.type('重连之后我还在');
  check('重连后消息通道恢复', await waitUntil(
    async () => (await A.eval('__rt.messages')).some((m) => m.text === '重连之后我还在'),
    '重连后的消息', 20000,
  ).then(() => true).catch(() => false));

  check('重连后麦克风自动接回新连接（否则对方会突然听不见）', await waitUntil(
    async () => (await B.eval('__rt.remoteAudioTracks')) > 0,
    '重连后重新收到音频轨道', 25000,
  ).then(() => true).catch(() => false));

  /* ---------------------------- 6. 请出房间 ---------------------------- */
  section('6. 把不合适的人请出房间');

  // 重连之后 A 已经认得 B 了 —— 提示条应当变成极轻的「已确认」，不再大惊小怪
  await waitUntil(async () => (await A.eval('__rt.trustClass')).includes('ok'), 'A 认出熟人', 12000)
    .then(() => check('认得的设备不再重复警告', true))
    .catch(async () => check('认得的设备不再重复警告', false, await A.eval('__rt.trustClass')));

  check('熟人状态下「请出房间」依然可达（用户需要能反悔）',
    await A.eval('!document.getElementById("trust-kick").hidden'));

  const kickedBefore = await B.eval('__rt.kickedCount');
  await A.click('trust-kick');                 // 真的去点那个按钮，不走内部函数
  await waitUntil(async () => (await B.eval('__rt.kickedCount')) > kickedBefore, 'B 收到被请出通知', 15000);
  check('A 点一下就能把对端请出房间', true);

  const bBack = await waitUntil(async () => {
    const st = await B.eval('({ gate: !document.getElementById("gate").hidden, room: !document.getElementById("room").hidden })');
    return st.gate && !st.room;
  }, 'B 退回入口', 10000).then(() => true).catch(() => false);
  check('被请出的一方退回入口', bBack);
  check('被请出的一方看到了原因', /请出/.test(await B.eval('document.getElementById("gate-error").textContent')));
  check('A 回到等待状态', (await A.eval('__rt.status')).includes('等待'));

  // 被请出过的设备再进来 → 自动再请走，不必手动点第二次
  const kicked2 = await B.eval('__rt.kickedCount');
  await B.enter(PASSPHRASE);
  const autoKicked = await waitUntil(async () => (await B.eval('__rt.kickedCount')) > kicked2, 'B 再次被自动请出', 25000)
    .then(() => true).catch(() => false);
  check('被请出过的设备再进来会被自动请走', autoKicked);

  /* ---------------------------- 结果 ---------------------------- */
  console.log('\n' + '─'.repeat(56));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('─'.repeat(56) + '\n');
  return fail;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error('\n测试中断：' + e.message);
  code = 2;
} finally {
  await cleanup();
}
process.exit(code);
