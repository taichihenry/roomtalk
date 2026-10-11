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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本机代理会劫持 localhost，先把环境变量摘干净
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

/* 便携版 Chrome 挪过窝（E:/softs → E:/softs/vpn），所以按候选表探测而不是写死。
   ⚠ 写死一个路径的代价很大：Chrome 一挪，e2e 会以「Chrome 未能就绪」这种
     跟代码毫无关系的错失败，白查半天。CHROME 环境变量仍可覆盖。 */
const CHROME_CANDIDATES = [
  'E:/softs/vpn/Chrome153_AllNew_2026.9.12/App/chrome.exe',
  'E:/softs/Chrome153_AllNew_2026.9.12/App/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const CHROME = process.env.CHROME
  || CHROME_CANDIDATES.find((p) => existsSync(p))
  || CHROME_CANDIDATES[0];
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

  /**
   * 视觉留档：把当前视口截一张存到 docs/。
   * 纯给人眼复核用（等分 / 放大长什么样、小窗位置对不对），**不参与断言** ——
   * 断言归上面的几何测量，截图只是让 review 的人不用自己跑起来。
   */
  async shoot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const abs = join(dirname(fileURLToPath(import.meta.url)), '..', file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(r.data, 'base64'));
    console.log('   · 截图 ' + file);
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

  // 首页的自测入口：把「浏览器/系统没放权限」和「本站的问题」分开的那两条外链。
  // 这两条是用户自助排查的第一站，点了没反应比没有更糟，所以 href / target / rel 都钉死。
  const selftest = await A.eval('__rt.selfTestLinks');
  check('首页提供了摄像头 / 麦克风自测外链', selftest.length === 2, selftest);
  check('自测外链分别指向 webcamtests 与 mictests',
    selftest.some((l) => /webcamtests\.com/.test(l.href))
    && selftest.some((l) => /mictests\.com/.test(l.href)), selftest);
  check('自测外链新窗口打开、且带 noopener',
    selftest.every((l) => l.target === '_blank' && /noopener/.test(l.rel)), selftest);
  check('自测入口默认收起（首屏仍然只有「输口令」一件事）',
    (await A.eval('document.querySelector(".selftest").open')) === false);

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

  // 房主 = 第一个进房的人。A 先进，B 后进 —— 权限只给 A
  check('第一个进房的人（A）是房主', await A.eval('__rt.isHost') === true);
  check('后进房的人（B）不是房主', await B.eval('__rt.isHost') === false);

  // 身份核对：纯口令没法证明「你是这个人」，所以必须如实告诉用户这是第一次
  await waitUntil(async () => A.eval('__rt.trustShown'), 'A 收到身份提示', 12000);
  check('首次通话被明确标注为「第一次」（不假装已经认证过）',
    (await A.eval('__rt.trustClass')).includes('first'), await A.eval('__rt.trustClass'));
  // ⚠ 首访**绝不能自动记住**：口令谁先拿到谁先进，自动信任等于把「先到的那个
  //   陌生人」永久写成「已确认」，真正的对方反而成了「设备换过」的可疑对象。
  //   所以第一次只报告事实，要不要收下由用户点一下。
  check('第一次进来时并没有被自动记为「已确认」',
    !(await A.eval('__rt.trustClass')).includes('ok')
    && await A.eval('__rt.trustKeepShown') === true,
    { cls: await A.eval('__rt.trustClass'), keep: await A.eval('__rt.trustKeepShown') });
  await A.click('trust-keep');
  check('用户点「记住这台设备」之后，提示条的标题才变成「已确认」',
    (await A.eval('__rt.trustClass')).includes('ok'), await A.eval('__rt.trustClass'));
  check('双方交换到了对方的设备标识',
    !!(await A.eval('__rt.peerDeviceId')) && !!(await B.eval('__rt.peerDeviceId')));
  check('两端设备标识不同', await A.eval('__rt.peerDeviceId') !== await B.eval('__rt.peerDeviceId'));

  // 设备名条：每台设备进房时自动报上自己是什么设备，双方照着念一遍就能对上人
  await waitUntil(async () => (await B.eval('__rt.metaOther')) !== '未进入', 'B 看到对方的设备名', 12000)
    .then(() => check('对端的设备名会自动显示出来（口令之外多一道口头核对）', true))
    .catch(async () => check('对端的设备名会自动显示出来', false, await B.eval('__rt.metaOther')));
  check('本机设备名不是占位符', !['', '—'].includes(await A.eval('__rt.metaSelf')));
  check('两端显示的是同一个设备名（同一台机器上的两个浏览器）',
    await A.eval('__rt.metaOther') === await B.eval('__rt.metaSelf'),
    { a见到的对方: await A.eval('__rt.metaOther'), b自己的: await B.eval('__rt.metaSelf') });

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
  section('3. 视频通话：发起 → 对方接听 → 全屏通话界面');

  // 顶栏刻意不再放麦克风/摄像头的开关（两个「发起通话」入口已经覆盖了这件事），
  // 所以这里先钉住「顶栏是干净的」，再用真实路径打通一次通话。
  check('顶栏不再放麦克风 / 摄像头 / 翻转的开关按钮',
    await A.eval('!document.querySelector(".bar #btn-mic, .bar #btn-cam, .bar #btn-flip") === true'));
  check('输入栏里有发起语音 / 视频通话的入口',
    await A.eval('!!document.getElementById("btn-call-audio") && !!document.getElementById("btn-call-video")'));

  await A.click('btn-call-video');
  await waitUntil(async () => (await A.eval('__rt.callUiShown')) === true, 'A 进入通话界面', 12000);
  check('发起方立刻铺开全屏通话界面', await A.eval('__rt.callMode') === true);
  check('呼叫中：状态写明「正在呼叫」，时长先不显示',
    await A.eval('__rt.callRinging') === true
    && (await A.eval('__rt.callStateText')).includes('呼叫'), await A.eval('__rt.callStateText'));
  check('通话界面里聊天输入栏被收起（从这里就点不到「发起通话」了）',
    await A.eval('__rt.composerHidden') === true);
  check('通话界面上有挂断按钮', await A.eval('!!document.getElementById("btn-hangup-call")'));
  // 互斥的第二道保险：界面之外（脚本 / 无障碍工具）再点一次发起也进不去
  await A.click('btn-call-audio');
  check('正在呼叫时再点另一颗发起按钮也无效（不会串成第二通电话）',
    await A.eval('__rt.callKind') === 'video', await A.eval('__rt.callKind'));

  await waitUntil(async () => await B.eval('__rt.ringShown'), 'B 弹出通话请求', 12000)
    .then(() => check('发起方一按，对方就收到通话请求', true))
    .catch(async () => check('发起方一按，对方就收到通话请求', false, await B.eval('__rt.ringShown')));
  check('来电浮层说明了是哪一种通话',
    /视频/.test(await B.eval('document.getElementById("ring-title").textContent')),
    await B.eval('document.getElementById("ring-title").textContent'));

  // ⭐ 隐私底线：**「对方按了发起」不等于「我愿意接」**。未接听之前，他的音视频
  //    一个字节都不该到我这儿（用户实际踩到过：还没接听就听见对方说话、还看到画面）。
  //    这条必须**先等一拍再断言** —— 轨道若真会传过来，2.5 秒足够它到；否则断言会
  //    因为「跑得比 ICE 快、轨道还在路上」而假绿。
  await new Promise((r) => setTimeout(r, 2500));
  check('对方未接听时，收不到他的任何音视频轨道',
    await B.eval('__rt.remoteAudioTracks') === 0 && await B.eval('__rt.remoteVideoTracks') === 0,
    { a: await B.eval('__rt.remoteAudioTracks'), v: await B.eval('__rt.remoteVideoTracks') });
  check('未接听时远端画面不进播放元素（否则挂断后会定格在最后一帧）',
    await B.eval('!document.getElementById("remote-video").srcObject'));
  check('未接听时，接听方自己也没开麦（麦克风要等接听那一刻才开）',
    await B.eval('__rt.media.audio') === false, await B.eval('__rt.media'));

  // 发起方中途挂断：浮层必须消失，而且此后**即便硬点接听也不能接通** ——
  // 否则会接通一通早已结束的电话，而对方那头的连接还在，能听见你说话。
  await A.click('btn-hangup-call');
  check('发起方挂断后，来电浮层立刻收掉',
    await waitUntil(async () => (await B.eval('__rt.ringShown')) === false, 'B 收起来电浮层', 8000)
      .then(() => true).catch(() => false), await B.eval('__rt.ringShown'));
  check('挂断后两端都不在通话中',
    await A.eval('__rt.inCall') === false && await B.eval('__rt.inCall') === false,
    { a: await A.eval('__rt.callKind'), b: await B.eval('__rt.callKind') });
  check('挂断后发起方的麦克风 / 摄像头真的松开了（设备指示灯必须灭）',
    await A.eval('__rt.media.audio === false && __rt.media.video === false'),
    await A.eval('__rt.media'));

  await B.click('ring-accept');   // 浮层已经收起了，这里硬点一下接听入口
  await new Promise((r) => setTimeout(r, 1500));
  check('浮层收起后硬点「接听」也接不通，更不会把自己的麦克风推过去',
    await B.eval('__rt.inCall') === false && await B.eval('__rt.media.audio') === false,
    { call: await B.eval('__rt.callKind'), media: await B.eval('__rt.media') });

  // 重新发起一次，让下面几节继续在「正在响铃」的状态上往下走
  await A.click('btn-call-video');
  await waitUntil(async () => (await A.eval('__rt.callRinging')) === true, 'A 重新进入呼叫', 12000);
  await waitUntil(async () => await B.eval('__rt.ringShown'), 'B 再次收到通话请求', 12000);
  check('重新发起后对方再次收到请求', await B.eval('__rt.ringShown') === true);

  await B.click('ring-accept');
  check('接听后浮层收起', await B.eval('__rt.ringShown') === false);
  // ⚠ 接听是异步的（要等 getUserMedia），click() 一返回就断言会拿到旧值 —— 必须等
  check('接听这个动作本身就打开了对方的麦克风（不依赖再去点别处）',
    await waitUntil(async () => (await B.eval('__rt.media.audio')) === true, 'B 麦克风就绪', 20000)
      .then(() => true).catch(() => false), await B.eval('__rt.media'));
  check('视频通话接听后对方摄像头也开了',
    await waitUntil(async () => (await B.eval('__rt.media.video')) === true, 'B 摄像头就绪', 25000)
      .then(() => true).catch(() => false), await B.eval('__rt.media'));
  check('接听方也铺开了全屏通话界面', await B.eval('__rt.callMode') === true);
  check('两端都进入通话态', await A.eval('__rt.inCall') === true && await B.eval('__rt.inCall') === true);
  check('接通后开始计时', /^\d\d:\d\d$/.test(await A.eval('__rt.callTimerText')),
    await A.eval('__rt.callTimerText'));
  check('通话界面上写着对方是谁', (await A.eval('__rt.callPeerText')).length > 0,
    await A.eval('__rt.callPeerText'));

  await waitUntil(async () => (await B.eval('__rt.remoteVideoTracks')) > 0, 'B 收到 A 的视频轨道', 25000);
  check('A 开摄像头 → B 收到视频轨道', true);
  check('B 侧界面显示视频区', await B.eval('!document.getElementById("stage").hidden'));
  check('B 侧标记「对方已开摄像头」', await B.eval('__rt.remoteMedia.video === true'));
  await waitUntil(async () => (await A.eval('__rt.remoteVideoTracks')) > 0, 'A 收到 B 的视频轨道', 25000);
  check('B 开摄像头 → A 收到视频轨道（双向视频）', true);
  check('A 侧标记「对方已开麦克风」', await A.eval('__rt.remoteMedia.audio === true'));
  check('双向媒体共存', (await B.eval('__rt.remoteVideoTracks')) > 0
    && (await A.eval('__rt.remoteVideoTracks')) > 0);
  check('远端声音没有被自动播放策略挡住', await B.eval('__rt.audioBlocked') === false);

  /* --- 码率与降级偏好：决定「弱网下是掉画质还是掉流畅」的两个参数 --- */
  const vs = await A.eval('__rt.videoStats()');
  check('默认档位是「流畅」', vs.quality === 'smooth', vs.quality);
  check('视频发送端已设码率上限（不会把上行打满）',
    vs.maxBitrate === 600000, vs.maxBitrate);
  check('降级偏好 = 保帧率（带宽不够时降分辨率、不丢帧）',
    vs.degradationPreference === 'maintain-framerate', vs.degradationPreference);
  check('采集端采 720p（再往下压交给编码前缩放，切档才能瞬时生效）',
    vs.captureHeight > 0 && vs.captureHeight <= 720, { w: vs.captureWidth, h: vs.captureHeight });
  // ⚠ 这一条原本只取上面那一次采样。但 Chrome 的 outbound-rtp 里 `framesPerSecond`
  //   只在「一个统计区间走完」之后才有值：刚连上就取，经常拿到 fps=null 而
  //   bytesSent 已经有数（说明帧确实在发）—— 单次采样会随机翻车。
  //   所以这里等一个带上 fps 的样本。**断言没变**（就是要 fps > 0），只是去掉了竞态。
  let fpsSample = null;
  check('视频确实在持续出帧（不是黑屏或停帧）',
    await waitUntil(async () => {
      fpsSample = await A.eval('__rt.videoStats()');
      return fpsSample.fps > 0;
    }, '编码器开始出帧', 12000).then(() => true).catch(() => false),
    { fps: fpsSample && fpsSample.fps, sent: fpsSample && fpsSample.bytesSent });
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
  //
  // ⚠ 两处采样都得挑一挑，否则会随机翻车（改之前踩过）：
  //   · `bytesSent` 缺失 → delta 算成 NaN（getStats 是按统计区间给的，不是每次都有全部字段）
  //   · 两次取到**同一个快照** → delta = 0，看着像「没在发」
  //   所以第二次要等一个「比第一次更大」的样本，并按**真实经过的秒数**换算，
  //   不能硬除以 3 —— 等样本用掉的时间也算在上行里。
  const sampleBytes = (min) => waitUntil(async () => {
    const s = await A.eval('__rt.videoStats()');
    return (typeof s.bytesSent === 'number' && s.bytesSent > (min ?? -1)) ? s : null;
  }, '拿到带上行字节数的样本', 12000);

  const t0 = Date.now();
  const v1 = await sampleBytes();
  await sleep(3000);
  const v2 = await sampleBytes(v1.bytesSent);
  const secs = (Date.now() - t0) / 1000;
  const kbps = Math.round(((v2.bytesSent - v1.bytesSent) * 8) / secs / 1000);
  console.log(`     实测 ${secs.toFixed(1)} 秒：上行 ${kbps} kbps · ${v2.width}x${v2.height} @ ${v2.fps}fps`
    + ` · 采集 ${v2.captureWidth}x${v2.captureHeight} · 受限原因 ${v2.qualityLimitation}`);
  check('实测上行码率确实在上限之内',
    kbps > 0 && kbps <= vs.maxBitrate / 1000 + 60, { kbps, cap: vs.maxBitrate / 1000, secs });

  check('对方收到了我的画质档位（免得以为是自己的问题）',
    await waitUntil(async () => (await B.eval('__rt.remoteQuality')) === 'smooth', 'B 收到档位', 8000)
      .then(() => true).catch(() => false));

  await A.click('btn-cam');
  await waitUntil(async () => (await A.eval('__rt.media.video')) === false, 'A 关闭摄像头');
  check('通话中关掉自己的摄像头：本端状态同步',
    await A.eval('__rt.media.video') === false);
  check('通话中关掉摄像头**不会**把通话也结束掉（只是这路视频没了）',
    await A.eval('__rt.callKind') === 'video', await A.eval('__rt.callKind'));
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

  // A 这会儿正处在前一节那通视频通话里（麦克风开着）：重连后它必须自动接回新连接
  // （这一步最容易漏 —— 媒体流挂在 S.localStream 上，靠 buildPeerConnection 重新 addTrack）
  check('重连前 A 正在通话中、麦克风开着',
    await A.eval('__rt.inCall') === true && await A.eval('__rt.media.audio') === true,
    { kind: await A.eval('__rt.callKind'), media: await A.eval('__rt.media') });

  // ⚠ 这条是**线上翻过车**的地方：不能只靠「重连后通话还在不在」来验，
  // 因为本地 wrangler dev 同进程重连只要几十毫秒，1.5 秒的宽限期怎么都够，
  // 线上却要「退避 + WS 握手 + 重新注册」远超 1.5 秒 —— 宽限期一到就把正在
  // 进行的通话掐了。所以直接断言「通话态的宽限期必须给足」，与网络快慢无关。
  check('通话中「对方离开」的宽限期给足 20 秒（短于线上重连耗时就会误杀通话）',
    await A.eval('__rt.peerLeftGrace') >= 20000, await A.eval('__rt.peerLeftGrace'));

  // 掐掉 B 的信令连接，模拟网络抖动 / 切基站
  await B.eval('window.__rt.__dropSocket(), true');
  await waitUntil(async () => (await B.eval('__rt.status')).includes('重连'), 'B 进入重连状态', 10000);
  check('B 检测到掉线并自动重连', true);

  await waitUntil(async () => (await B.eval('__rt.status')).includes('已连接'), 'B 重新接通', 30000);
  await waitUntil(async () => (await A.eval('__rt.status')).includes('已连接'), 'A 侧恢复', 30000);
  check('两端自动恢复连接，无需用户操作', true);

  // ⚠ 不能只等状态栏那句「已连接」：它是 pc.connectionState 变 connected 时设的，
  // 而 DataChannel 的 open 通常还在它之后（线上延迟大时这个窗口明显得多）。
  // 卡在窗口里发消息，sendText() 会因为 dc 还没 open 而返回 false —— 消息压根没
  // 发出去，看起来就像「重连后消息通道坏了」。判据必须用 dcOpen（README 第九节记过这个坑）。
  await waitUntil(async () => (await B.eval('__rt.dcOpen')) === true, 'B 的 DataChannel 恢复', 25000)
    .then(() => check('重连后 DataChannel 真正 open（不只是 PC 通了）', true))
    .catch(async () => check('重连后 DataChannel 真正 open（不只是 PC 通了）', false,
      await B.eval('__rt.dcOpen')));

  check('通话在重连后没有被打断（不会因为掉一次线就把人踢出通话界面）',
    await A.eval('__rt.inCall') === true && await B.eval('__rt.inCall') === true,
    { a: await A.eval('__rt.callKind'), b: await B.eval('__rt.callKind') });

  check('重连后麦克风自动接回新连接（否则对方会突然听不见）', await waitUntil(
    async () => (await B.eval('__rt.remoteAudioTracks')) > 0,
    '重连后重新收到音频轨道', 25000,
  ).then(() => true).catch(() => false));

  // 挂断，回到聊天态 —— 后面几节（请人出去、发语音、发文件）都是聊天态的事
  await A.click('btn-hangup-call');
  await waitUntil(async () => (await A.eval('__rt.inCall')) === false
    && (await B.eval('__rt.inCall')) === false, '两端都退出通话', 20000)
    .then(() => check('挂断后双方都退出全屏通话界面', true))
    .catch(async () => check('挂断后双方都退出全屏通话界面', false,
      { a: await A.eval('__rt.callKind'), b: await B.eval('__rt.callKind') }));
  check('挂断后输入栏回来了（可以继续聊天）', await A.eval('__rt.composerHidden') === false);
  check('挂断后本地麦克风/摄像头都关掉（设备指示灯必须灭）',
    await A.eval('__rt.media.audio === false && __rt.media.video === false'),
    await A.eval('__rt.media'));
  check('对方那端也一并收掉了媒体（不会留下一个单向亮着的摄像头）',
    await B.eval('__rt.media.audio === false && __rt.media.video === false'),
    await B.eval('__rt.media'));

  await B.type('重连之后我还在');
  check('重连后消息通道恢复', await waitUntil(
    async () => (await A.eval('__rt.messages')).some((m) => m.text === '重连之后我还在'),
    '重连后的消息', 20000,
  ).then(() => true).catch(() => false));

  /* ---------------------------- 6. 请出房间 ---------------------------- */
  section('6. 把不合适的人请出房间');

  // 重连之后 A 已经认得 B 了 —— 提示条应当变成极轻的「已确认」，不再大惊小怪
  await waitUntil(async () => (await A.eval('__rt.trustClass')).includes('ok'), 'A 认出熟人', 12000)
    .then(() => check('认得的设备不再重复警告', true))
    .catch(async () => check('认得的设备不再重复警告', false, await A.eval('__rt.trustClass')));

  check('熟人状态下「请出房间」依然可达（房主 A 看得到）',
    await A.eval('__rt.kickBtnShown') === true);
  check('后进房的人（B）看不到「请出房间」按钮（没有这个权限）',
    await B.eval('__rt.kickBtnShown') === false);

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

  /* ---------------------------- 7. 误请之后的回头路 ---------------------------- */
  section('7. 「自动请出」开关 —— 手滑误请之后必须有回头路');

  /*
   * ⚠ 不能拿「状态文案含『已连接』」当重连成功的判据：状态栏在断线后**不会**被清空，
   *   旧文案还挂在那儿，waitUntil 第一轮就会立刻返回（等于没等）。
   *   真正可靠的判据是两条：连接换了一条（peerId 每次建连都重新生成）+ 数据通道确实开着。
   */
  const waitReconnected = (page, beforePeerId, label) => waitUntil(async () =>
    (await page.eval('__rt.peerId')) !== beforePeerId && (await page.eval('__rt.dcOpen')) === true,
    label, 30000);

  check('房主能看到「自动请出」开关', await A.eval('__rt.autokickShown') === true);
  check('后进者看不到房主专属控件', await B.eval('__rt.autokickShown') === false);
  check('黑名单里确实有 1 台设备', await A.eval('__rt.blockedCount') === 1);
  check('房主能看到「解除拉黑」入口（名单非空）',
    await A.eval('!document.getElementById("btn-unblock").hidden') === true);

  // 关掉「自动请出」→ 被拉黑的人再进来不再被自动赶走。这正是「点错了」的补救。
  const setAutoKick = (on) => `(() => {
    const c = document.getElementById('autokick');
    c.checked = ${on};
    c.dispatchEvent(new Event('change', { bubbles: true }));
    return c.checked;
  })()`;
  await A.eval(setAutoKick(false));
  check('开关能关掉（偏好存在本机）', await A.eval('__rt.autoKick') === false);

  const kicked3 = await B.eval('__rt.kickedCount');
  const bPeerBefore = await B.eval('__rt.peerId');
  await B.enter(PASSPHRASE);
  await waitReconnected(B, bPeerBefore, 'B 重新接通');
  check('关掉自动请出后，被拉黑的人能正常连上（不再被自动赶走）',
    (await B.eval('__rt.kickedCount')) === kicked3);
  check('房主侧看得到对方回来了（设备名条有内容）',
    (await A.eval('__rt.peerName') || '').length > 0, await A.eval('__rt.metaOther'));

  // 解除拉黑：把名单清空，彻底回到「没拉黑过」的状态
  await A.click('btn-unblock');
  check('解除拉黑后名单清空', await A.eval('__rt.blockedCount') === 0);
  check('名单清空后「解除拉黑」入口自动收起',
    await A.eval('!document.getElementById("btn-unblock").hidden') === false);

  await A.eval(setAutoKick(true));
  check('开关能再开回来（不是单向的）', await A.eval('__rt.autoKick') === true);

  /* ---------------------------- 8. 通话入口与音视频布局 ---------------------------- */
  section('8. 发起通话 / 全屏视频区 / 语音消息 / 发文件');

  // --- 8a. 「发起视频通话」→ 对方接听（第 3 节已走过一遍，这里再走一次，
  //     顺便把「通话中不能重复发起」这条互斥规则钉死）---
  check('此刻不在通话中（上一通已经挂断）', await A.eval('__rt.inCall') === false);

  await A.click('btn-call-video');
  await waitUntil(async () => await B.eval('__rt.ringShown'), 'B 弹出通话请求', 12000)
    .then(() => check('发起方一按，对方就收到通话请求', true))
    .catch(async () => check('发起方一按，对方就收到通话请求', false, await B.eval('__rt.ringShown')));
  check('来电浮层说明了是哪一种通话',
    /视频/.test(await B.eval('document.getElementById("ring-title").textContent')),
    await B.eval('document.getElementById("ring-title").textContent'));

  // 对方还没接：这时发起方已经占着通话态，再点另一颗发起按钮也不该起作用
  await A.click('btn-call-audio');
  check('呼叫未接时再点发起无效（通话态是互斥的）',
    await A.eval('__rt.callKind') === 'video', await A.eval('__rt.callKind'));

  await B.click('ring-accept');
  check('接听后浮层收起', await B.eval('__rt.ringShown') === false);
  // ⚠ 接听是异步的（要等 getUserMedia），click() 一返回就断言会拿到旧值 —— 必须等
  check('接听这个动作本身就打开了对方的麦克风（不依赖再去点别处）',
    await waitUntil(async () => (await B.eval('__rt.media.audio')) === true, 'B 麦克风就绪', 20000)
      .then(() => true).catch(() => false), await B.eval('__rt.media'));
  check('视频通话接听后对方摄像头也开了',
    await waitUntil(async () => (await B.eval('__rt.media.video')) === true, 'B 摄像头就绪', 25000)
      .then(() => true).catch(() => false), await B.eval('__rt.media'));
  check('发起方收到了对方的视频轨道（双向视频）', await waitUntil(
    async () => (await A.eval('__rt.remoteVideoTracks')) > 0, 'A 收到 B 的视频', 25000,
  ).then(() => true).catch(() => false));
  check('远端声音没有被自动播放策略挡住', await B.eval('__rt.audioBlocked') === false);

  // --- 8b. 视频区 = 全屏舞台 + 微信式的「一大一小」---
  // 用户要的就是微信那个样子：一方铺满整屏，另一方缩在右上角的小窗里。
  // ⚠ 自动摆位要等对方的 media 状态经 DataChannel 到达，不能点完就断言
  await waitUntil(async () => (await A.eval('__rt.stageMain')) === 'remote',
    '画面自动切成「对方大」', 12000)
    .then(() => check('视频通话默认把对方放成大的那格', true))
    .catch(async () => check('视频通话默认把对方放成大的那格', false,
      { main: await A.eval('__rt.stageMain'), remoteMedia: await A.eval('__rt.remoteMedia') }));
  check('默认就带放大状态（.pip），我这一格缩成右上角小窗',
    await A.eval('__rt.stagePip') === true
    && JSON.stringify(await A.eval('__rt.smallPane')) === '["local"]',
    { pip: await A.eval('__rt.stagePip'), small: await A.eval('__rt.smallPane') });
  check('视频通话时舞台铺满整个屏幕（全屏通话，而不是嵌在聊天里的一条）',
    await A.eval(`(() => {
      const s = document.getElementById('stage').getBoundingClientRect();
      const w = document.documentElement.clientWidth;
      const h = document.documentElement.clientHeight;
      return Math.abs(s.width - w) < 2 && Math.abs(s.height - h) < 2;
    })()`), await A.eval(`(() => {
      const s = document.getElementById('stage').getBoundingClientRect();
      return { w: Math.round(s.width), h: Math.round(s.height),
               vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
    })()`));
  const panes = await A.eval(`(() => [...document.querySelectorAll('#stage .pane')]
    .map((p) => { const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }))()`);
  check('舞台里确实是两块画面（大 + 小）', panes.length === 2, panes);
  check('大窗严格 contain 不裁切，小窗用 cover 当缩略图',
    await A.eval(`getComputedStyle(document.querySelector('#stage .pane:not(.small) video')).objectFit`) === 'contain'
    && await A.eval(`getComputedStyle(document.querySelector('#stage .pane.small video')).objectFit`) === 'cover');
  check('视频窗口角标带上了设备名（视频里也能核对对面是谁）',
    /对方/.test(await A.eval('__rt.remoteTag')) && /我/.test(await A.eval('__rt.localTag')),
    { remote: await A.eval('__rt.remoteTag'), local: await A.eval('__rt.localTag') });

  await A.shoot('docs/shot-call-remote.png');   // 默认：对方铺满 + 我缩在右上角

  // --- 8b-2. 点画面切换大小（要能来回换）---
  await A.eval('document.getElementById("pane-local").click(), true');
  check('点右上角小窗（我）→ 我铺满、对方缩成小窗',
    (await A.eval('__rt.stageMain')) === 'local'
    && (await A.eval('__rt.stagePip')) === true
    && JSON.stringify(await A.eval('__rt.smallPane')) === '["remote"]',
    { main: await A.eval('__rt.stageMain'), small: await A.eval('__rt.smallPane') });

  // 光看类名不够 —— 真放大得在**几何**上成立：大窗铺满舞台宽度，小窗明显更小
  const pipBox = await A.eval(`(() => {
    const s = document.getElementById('stage').getBoundingClientRect();
    const big = document.querySelector('#stage .pane:not(.small)').getBoundingClientRect();
    const small = document.querySelector('#stage .pane.small').getBoundingClientRect();
    return { stageW: Math.round(s.width), bigW: Math.round(big.width),
             smallW: Math.round(small.width), smallH: Math.round(small.height),
             smallTop: Math.round(small.top - s.top), smallRight: Math.round(s.right - small.right) };
  })()`);
  check('大窗真的铺满了整个舞台宽度', pipBox.bigW >= pipBox.stageW - 2, pipBox);
  check('小窗确实小（不到大窗的一半宽）', pipBox.smallW > 0 && pipBox.smallW < pipBox.bigW / 2, pipBox);
  check('小窗贴在舞台右上角',
    pipBox.smallTop >= 0 && pipBox.smallTop < 40 && pipBox.smallRight >= 0 && pipBox.smallRight < 40, pipBox);

  check('大窗仍然 contain 不裁切，小窗用 cover 当缩略图',
    await A.eval(`getComputedStyle(document.querySelector('#stage .pane:not(.small) video')).objectFit`) === 'contain'
    && await A.eval(`getComputedStyle(document.querySelector('#stage .pane.small video')).objectFit`) === 'cover');

  await A.shoot('docs/shot-call-self.png');    // 点过我这一格之后：我铺满 + 对方小窗

  await A.eval('document.getElementById("pane-remote").click(), true');
  check('再点对方那格 → 换回对方铺满、我缩成小窗（可来回切）',
    (await A.eval('__rt.stageMain')) === 'remote'
    && JSON.stringify(await A.eval('__rt.smallPane')) === '["local"]',
    { main: await A.eval('__rt.stageMain'), small: await A.eval('__rt.smallPane') });

  // 摄像头朝向：初始必须是前置（手机上打开视频先看到自己），切换按钮只在真有多摄时露
  check('开视频默认用前置摄像头', (await A.eval('__rt.facing')) === 'user', await A.eval('__rt.facing'));
  console.log('   摄像头数量：', await A.eval('__rt.camCount'),
    '· 切换按钮：', (await A.eval('__rt.flipShown')) ? '显示' : '隐藏');

  // --- 8b-3. 切换前后摄像头 ---
  // headless 只有一个假摄像头，真机才是双摄 —— 所以这里不赌「一定切得过去」，
  // 只钉死两件绝不能破的事：① 切完本地一定还有一条**活着**的视频轨（黑屏最严重）；
  // ② 本地流里不能残留旧轨（否则摄像头指示灯灭不掉，用户会以为被偷拍）。
  const camBefore = await A.eval(`(() => {
    const lv = document.getElementById('local-video');
    const t = lv.srcObject && lv.srcObject.getVideoTracks()[0];
    return { live: !!t && t.readyState === 'live', id: t ? t.id : null,
             facing: __rt.facing, mirror: lv.classList.contains('mirror') };
  })()`);
  check('切之前：前置 + 本地是活画面 + 处于镜像状态',
    camBefore.live && camBefore.facing === 'user' && camBefore.mirror === true, camBefore);

  await A.click('btn-flip');
  await sleep(1500);   // 换轨是异步的（要等一次 getUserMedia）
  const camAfter = await A.eval(`(() => {
    const lv = document.getElementById('local-video');
    const tracks = lv.srcObject ? lv.srcObject.getVideoTracks() : [];
    const t = tracks[0];
    return { live: !!t && t.readyState === 'live', count: tracks.length, id: t ? t.id : null,
             facing: __rt.facing, mirror: lv.classList.contains('mirror') };
  })()`);
  check('切换后本地仍是活画面（任何情况下都不能黑屏）', camAfter.live, camAfter);
  check('本地流里只剩一条视频轨（旧轨被停掉了，指示灯能灭）', camAfter.count === 1, camAfter);
  check('朝向与镜像始终配套：后置不镜像 / 前置才镜像',
    (camAfter.facing === 'environment' && camAfter.mirror === false)
    || (camAfter.facing === 'user' && camAfter.mirror === true),
    { facing: camAfter.facing, mirror: camAfter.mirror });
  console.log('   一次切换的结果：', camAfter.facing === 'environment' ? '已切到后置' : '本机只有一颗摄像头，保持前置',
    '· 轨道 id', camBefore.id === camAfter.id ? '未变（同一颗设备）' : '已更换');

  // 切回去了才算真的可来回 —— 顺便把状态还原，后面的用例还在前置上
  if (camAfter.facing === 'environment') {
    await A.click('btn-flip');
    await sleep(1500);
  }
  check('摄像头朝向可来回切（切回去仍是可用状态）',
    (await A.eval('__rt.facing')) === 'user'
    && (await A.eval(`document.getElementById('local-video').srcObject.getVideoTracks()[0].readyState`)) === 'live',
    { facing: await A.eval('__rt.facing') });

  // --- 8b-4. 模拟真机：手机没法同时开前后两颗摄像头 ---
  // 本机只有一颗假摄像头（连按钮都不显示），真机双摄才是这个 bug 的现场。
  // 这里直接换掉 navigator.mediaDevices：谎报还有第二颗，并让「明确指定某一颗」
  // 的采集先抛 NotReadableError —— 这正是 Android / iOS 双开被拒时浏览器给的错。
  // 用来看两阶段降级救不救得回来、以及救不回来时会不会把用户丢在黑屏上。
  const installCamMock = (mode) => `
    (async () => {
      const md = navigator.mediaDevices;
      if (!window.__mdOrig) {
        window.__mdOrig = { gum: md.getUserMedia.bind(md), ed: md.enumerateDevices.bind(md) };
      }
      const o = window.__mdOrig;
      const MODE = ${JSON.stringify(mode)};
      window.__mockSpec = 0;
      const def = (k, v) => Object.defineProperty(md, k, { configurable: true, writable: true, value: v });
      def('enumerateDevices', async () => [
        ...(await o.ed()),
        { deviceId: 'mock-back', groupId: 'g2', kind: 'videoinput', label: 'Back Camera' },
      ]);
      def('getUserMedia', async (c) => {
        const v = (c && c.video) || {};
        const specified = !!((v.facingMode && v.facingMode.exact) || (v.deviceId && v.deviceId.exact));
        if (!specified) return o.gum(c);          // 「随便给一颗」的请求照常放行
        window.__mockSpec++;
        // 手机的现实：旧摄像头还开着时，要另一颗必被拒。
        //   ok        —— 支持双开：全程放行
        //   busy-once —— 阶段 A 两次被拒，释放后第 3 次成功
        //   forever   —— 怎么都不给
        const reject = MODE === 'forever' || (MODE === 'busy-once' && window.__mockSpec <= 2);
        if (reject) {
          throw Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
        }
        return o.gum({ video: true });            // 旧轨放掉了 → 这次给一颗真轨道
      });
      return true;
    })()`;

  const uninstallCamMock = `
    (async () => {
      const o = window.__mdOrig;
      if (!o) return false;
      const md = navigator.mediaDevices;
      const def = (k, v) => Object.defineProperty(md, k, { configurable: true, writable: true, value: v });
      def('getUserMedia', o.gum);
      def('enumerateDevices', o.ed);
      window.__mdOrig = null;
      return true;
    })()`;

  const camSnap = `(async () => {
    const lv = document.getElementById('local-video');
    const tr = lv.srcObject ? lv.srcObject.getVideoTracks() : [];
    const t = tr[0];
    return { id: t ? t.id : null, n: tr.length, live: !!t && t.readyState === 'live',
             facing: __rt.facing, log: __rt.flipLog };
  })()`;

  // 场景一：支持双开的机型（桌面 / 部分旗舰）→ 阶段 A 直接成功，全程没释放过旧摄像头
  await A.eval(installCamMock('ok'));
  await A.eval('__rt.flip()');
  await sleep(1600);
  const s1 = await A.eval(camSnap);
  check('支持双开的机型：不释放旧摄像头就能直接换轨成功',
    s1.facing === 'environment' && s1.live && s1.n === 1
    && !s1.log.some((l) => l.includes('阶段B')),
    { facing: s1.facing, log: s1.log });

  // 场景二：**手机的现实** —— 旧摄像头还开着时，要另一颗被拒 → 释放后重试成功
  await A.eval(installCamMock('busy-once'));
  await A.eval('__rt.flip()');
  await sleep(2400);
  const s2 = await A.eval(camSnap);
  check('手机双开被拒 → 自动降级「先关旧摄像头再要」，并成功切过去',
    s2.facing === 'user' && s2.live && s2.n === 1
    && s2.log.some((l) => l.includes('阶段B成功')),
    { facing: s2.facing, log: s2.log });

  // 场景三：怎么都拿不到另一颗 → 必须回滚，绝不能停在没有画面的状态
  await A.eval(installCamMock('forever'));
  await A.eval('__rt.flip()');
  await sleep(2600);
  const s3 = await A.eval(camSnap);
  const s3toast = await A.eval('document.getElementById("toast").textContent');
  check('切不过去时回滚到原摄像头，画面仍然是活的（不黑屏）',
    s3.live && s3.n === 1 && s3.facing === 'user' && s3.log.some((l) => l.includes('回滚')),
    { facing: s3.facing, live: s3.live, log: s3.log });
  check('失败提示说清是「被占用」，而不是笼统一句「可能只有一颗」',
    /占用/.test(s3toast || ''), s3toast);

  await A.eval(uninstallCamMock);
  await A.eval('__rt.refreshCams()');
  check('卸掉模拟后回到真实设备：朝向复位为前置',
    (await A.eval('__rt.facing')) === 'user');

  // --- 8c. 语音消息（按住说话）---
  // 发消息是「聊天态」的事：先挂断那通视频，输入栏才会回来
  await A.click('btn-hangup-call');
  await waitUntil(async () => (await A.eval('__rt.inCall')) === false
    && (await B.eval('__rt.inCall')) === false, '两端挂断', 20000);
  check('挂断视频通话后输入栏回来了', await A.eval('__rt.composerHidden') === false);

  const voiceBefore = await B.eval('__rt.voiceCount');
  await A.click('btn-voice');
  check('输入栏能切到「按住说话」模式', await A.eval('__rt.voiceMode') === true);
  check('切过去后文字输入框让位给了说话按钮',
    await A.eval('document.getElementById("text").hidden && !document.getElementById("hold-talk").hidden'));

  // 「按住说话」在手机上是一条扁平长条时按不住 —— 现在是居中的大圆按钮
  const holdBox = await A.eval('__rt.holdTalkBox');
  check('「按住说话」是个放大的圆形按钮（手机上按得住）',
    !!holdBox && holdBox.w >= 56 && holdBox.h >= 56 && holdBox.w === holdBox.h
    && /50%|9999px/.test(holdBox.radius), holdBox);
  check('按钮上给了一个话筒图标 + 「按住」两字（不是光秃秃一个色块）',
    await A.eval(`!!document.querySelector('#hold-talk svg') && !!document.getElementById('hold-label')`));

  await A.eval(`(() => {
    const h = document.getElementById('hold-talk');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(400);
  check('按下后按钮进入录音态（变红 + 文案变「松开」）',
    await A.eval(`document.getElementById('hold-talk').classList.contains('recording')`)
    && await A.eval(`document.getElementById('hold-label').textContent`) === '松开',
    await A.eval(`document.getElementById('hold-label').textContent`));
  await sleep(1100);   // 总共录 ~1.5 秒（低于 0.5 秒会被当成误触丢弃）
  await A.eval(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), true`);

  check('按住录、松手发：这条语音落到了自己的消息里',
    await waitUntil(async () => (await A.eval('__rt.voiceCount')) > 0, 'A 出现语音气泡', 15000)
      .then(() => true).catch(() => false));
  check('语音消息通过 P2P 送达了对方（服务器不经手）',
    await waitUntil(async () => (await B.eval('__rt.voiceCount')) > voiceBefore, 'B 收到语音', 30000)
      .then(() => true).catch(async () => check('B 收到语音', false, await B.eval('__rt.voiceCount'))));

  /* --- 手机上「按住说话」按不住：把三条来路都钉住 ---
     这类问题在 headless 里复现不了（合成事件不会被浏览器收走），所以只能分别
     验证「防线的每一环在位」+「万一还是被打断，结果必须是可预期的」。 */

  // ① 浏览器把这次触摸收走（判成长按/滚动/缩放、或同时触点过多 —— 单手拿手机时
  //    掌根贴屏就属于这种）就会发 pointercancel，录音当场断掉。能不能被收走取决于
  //    touch-action，所以先断言它真的生效了（连子元素一起）—— 这是本机唯一能验的一半。
  const ta = await A.eval(`(() => {
    const b = document.getElementById('hold-talk');
    return { self: getComputedStyle(b).touchAction,
             kids: [...b.children].map((c) => getComputedStyle(c).touchAction) };
  })()`);
  check('按住按钮自己 + 里面的图标/文字都不让浏览器插手手势（touch-action: none）',
    ta.self === 'none' && ta.kids.length > 0 && ta.kids.every((v) => v === 'none'), ta);

  // ② 别的指针抬起不许打断正在录的语音。原来 pointerup 挂在 window 上，任何一次
  //    指针抬起（另一根手指、鼠标兼容事件、别处的点击）都会把这次录音掐掉。
  const voiceAfterFirst = await A.eval('__rt.voiceCount');
  await A.eval(`(() => {
    document.getElementById('hold-talk').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7 }));
    return true;
  })()`);
  await sleep(700);
  await A.eval(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 99 })), true`);
  await sleep(250);
  check('别的指针抬起不会打断正在录的语音',
    (await A.eval(`document.getElementById('hold-talk').classList.contains('recording')`)) === true
    && (await A.eval('__rt.holdWanted')) === true,
    { recording: await A.eval('__rt.recording'), label: await A.eval(`document.getElementById('hold-label').textContent`) });

  await sleep(1100);   // 累计按住约 2 秒
  await A.eval(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 })), true`);
  check('自己那根手指抬起来才算松手，并且这条语音发得出去',
    await waitUntil(async () => (await A.eval('__rt.voiceCount')) > voiceAfterFirst, 'A 出现第二条语音气泡', 15000)
      .then(() => true).catch(() => false));

  // ③ 万一还是被系统收走（pointercancel）：录到的部分必须照样发出去，不许静默丢弃。
  //    静默丢弃正是用户看到的「提示闪一下就断了，语音没发出去，也没个说法」。
  const voiceAfterSecond = await A.eval('__rt.voiceCount');
  await A.eval(`(() => {
    document.getElementById('hold-talk').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 8 }));
    return true;
  })()`);
  await sleep(1200);
  await A.eval(`window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 8 })), true`);
  check('触摸被系统收走时，录到的那段照样发得出去（不再默默丢掉）',
    await waitUntil(async () => (await A.eval('__rt.voiceCount')) > voiceAfterSecond, 'A 出现第三条语音气泡', 15000)
      .then(() => true).catch(() => false));

  // ④ 刚按下就松开（麦克风还没就绪）：按钮必须**立刻**回到待命，不许继续亮着红 ——
  //    原来那种「红光一直亮到麦克风就绪才闪掉」正是用户描述的「闪现一下就断了」。
  await A.eval(`(() => {
    const h = document.getElementById('hold-talk');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
    return true;
  })()`);
  await sleep(120);
  check('刚按下就松开：按钮立刻回到「按住」（不会留一个假装在录的红按钮）',
    (await A.eval(`document.getElementById('hold-label').textContent`)) === '按住'
    && (await A.eval(`document.getElementById('hold-talk').classList.contains('recording')`)) === false
    && (await A.eval('__rt.holdWanted')) === false,
    await A.eval(`document.getElementById('hold-label').textContent`));
  check('那一按也没把麦克风留在打开状态（不偷录）',
    await waitUntil(async () => (await A.eval('__rt.recording')) === false, '录音收干净', 10000)
      .then(() => true).catch(() => false));

  await A.click('btn-voice');
  check('能切回键盘模式', await A.eval('__rt.voiceMode') === false);

  // --- 8d. 发文件（分片 + 背压）---
  // 300KB 按 64KB 切片 = 5 片，正好把「分片重组」这条路径走通
  const fileBefore = await B.eval('__rt.fileCount');
  await A.eval(`(() => {
    const input = document.getElementById('file-input');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(300 * 1024).fill(65)], 'e2e-测试.txt', { type: 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  check('发出去的文件立刻出现在自己这一侧',
    await waitUntil(async () => (await A.eval('__rt.fileCount')) > 0, 'A 出现文件气泡', 20000)
      .then(() => true).catch(() => false));
  check('文件通过 P2P 送达，且在对方那边拼回了完整内容',
    await waitUntil(async () => (await B.eval('__rt.fileCount')) > fileBefore, 'B 收到文件', 40000)
      .then(() => true).catch(async () => check('B 收到文件', false, await B.eval('__rt.fileCount'))));
  check('收到的文件保留了原文件名与体积',
    await B.eval(`(() => {
      const n = document.querySelector('#log .msg.file .file-name');
      const s = document.querySelector('#log .msg.file .file-size');
      return n ? (n.textContent + '|' + (s ? s.textContent : '')) : '';
    })()`) === 'e2e-测试.txt|300 KB',
    await B.eval(`(() => {
      const n = document.querySelector('#log .msg.file .file-name');
      const s = document.querySelector('#log .msg.file .file-size');
      return n ? (n.textContent + '|' + (s ? s.textContent : '')) : '';
    })()`));

  /* ---------------------------- 9. 房主先退，房间不关 ---------------------------- */
  section('9. 房主先退出 → 房里的人接任房主 → 原房主回来是后进者');

  // 退出前先在通话里把摄像头开着 —— 否则下面那条「退出时松开设备」的断言等于没测。
  // （也顺手验证了「通话中直接点退出房间」这条更彻底的路：通话必须一并收干净。）
  await A.click('btn-call-video');
  await waitUntil(async () => await B.eval('__rt.ringShown'), 'B 弹出通话请求', 12000);
  await B.click('ring-accept');
  await waitUntil(async () => (await A.eval('__rt.media.video')) === true, 'A 摄像头就绪', 25000);
  const camWasOn = await A.eval('__rt.media.video');
  check('退出前 A 正开着摄像头且在通话中',
    camWasOn === true && await A.eval('__rt.inCall') === true);

  await A.eval('document.getElementById("btn-hangup").click(), true');
  check('直接退出房间时：通话界面收起、摄像头与麦克风真正松开（设备指示灯必须灭）',
    camWasOn === true
    && await A.eval('__rt.media.video === false && __rt.media.audio === false')
    && await A.eval('__rt.inCall') === false,
    { camWasOn });
  await waitUntil(async () => (await B.eval('__rt.isHost')) === true, 'B 接任房主', 20000);
  check('房主退出的那一刻，房里剩下的人立刻成为新房主', true);
  // ⚠ 这里刻意只等 6 秒（而不是宽限期的 20 秒）：对方是**主动退房**，走的是
  // endCall() 发出的 bye —— 那条是端到端、秒级到达的。若谁把「主动离开」也
  // 拖到 peer-left 的宽限期上，这条就会红，正是我们要拦住的行为。
  check('对方退出后，我这边的通话也自动收掉了（不会留一个对着空房间的摄像头）',
    await waitUntil(async () => (await B.eval('__rt.inCall')) === false, 'B 退出通话', 6000)
      .then(() => true).catch(() => false), await B.eval('__rt.callKind'));
  await waitUntil(async () => (await B.eval('__rt.isHost')) === true, 'B 接任房主', 20000);
  check('房主退出的那一刻，房里剩下的人立刻成为新房主', true);
  check('新房主拿到了「请出房间」的权限', await B.eval('__rt.kickBtnShown') === true);
  check('房间没有关闭（口令仍被这一方占着）', await waitUntil(
    async () => (await B.eval('__rt.status')).includes('等待'), 'B 回到等待状态', 12000,
  ).then(() => true).catch(() => false), await B.eval('__rt.status'));

  const aPeerBefore = await A.eval('__rt.peerId');
  await A.enter(PASSPHRASE);
  await waitReconnected(A, aPeerBefore, 'A 重新接通');
  check('原房主再进来是后进者，自动失去请出权限',
    await A.eval('__rt.isHost') === false, await A.eval('__rt.isHost'));
  check('原房主连「请出房间」按钮都看不到', await A.eval('__rt.kickBtnShown') === false);
  check('新房主依然持有权限', await B.eval('__rt.isHost') === true);

  // 两个人都退出，房间（也就是这个口令的占用）才真正腾空
  await B.eval('document.getElementById("btn-hangup").click(), true');
  await A.eval('document.getElementById("btn-hangup").click(), true');
  await sleep(800);
  check('两人都退出后都回到了入口',
    await A.eval('!document.getElementById("gate").hidden') === true &&
    await B.eval('!document.getElementById("gate").hidden') === true);

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
