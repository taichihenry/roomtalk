'use strict';
/* ===========================================================================
   语音 / 文件传输的端到端验证（真机 × 真浏览器）。

   为什么非要用真机跑：这条链路里有三件东西在模拟器上根本不存在 ——
     · MediaRecorder 的 AAC 编码器（模拟器上常缺）
     · 系统文件选择器（SAF）
     · FileProvider 递给别的应用时的授权
   而传输出错的典型症状又是「没报错但东西不对」（字节少了、扩展名错了、
   内容串了），必须用真实字节验。

   覆盖五个方向：
     A. 手机 → 网页   发语音（按住说话）
     B. 手机 → 网页   发文件（系统选择器）
     C. 网页 → 手机   发文件
     D. 手机自己那条语音能回放（验证 MediaPlayer 读 m4a）
     E. 手机退出房间 → 该房间在本机的信任/拉黑记忆被清掉（安卓侧「腾空即清空」）

   用法：
     node test/xfer-e2e.mjs                    # 默认用线上 https://8.中国，口令每跑一次随机生成
     RT_ORIGIN=http://127.0.0.1:8787 node test/xfer-e2e.mjs
     ONLY=C node test/xfer-e2e.mjs             # 只跑其中一步，便于单点调试
     PASS=某个口令 node test/xfer-e2e.mjs      # 指定口令（默认随机，避免撞上真实用户的房间）
   =========================================================================== */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const ADB = process.env.ADB || 'C:/Users/201/android-build/sdk/platform-tools/adb.exe';
const PKG = 'com.roomtalk.android';
const CHROME_CANDIDATES = [
  'E:/softs/vpn/Chrome153_AllNew_2026.9.12/App/chrome.exe',
  'E:/softs/Chrome153_AllNew_2026.9.12/App/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const CHROME = process.env.CHROME || CHROME_CANDIDATES.find((p) => existsSync(p)) || CHROME_CANDIDATES[0];
const ORIGIN = process.env.RT_ORIGIN || 'https://8.中国';

/**
 * 口令默认**每次随机生成**。
 *
 * ⚠ 别改回写死的 '1234'。这个脚本打的是**线上公开站点**：`1234` 这种口令随时
 *   会被真实用户占着，于是手机端提交口令后被服务端以 room-full 弹回口令页，
 *   而 toast 只闪 2.6 秒 —— 表现出来就是「手机卡在口令页、点进入没反应」，
 *   白查半天点击热区。随机口令把这类环境噪声从根上去掉。
 */
const PASS = process.env.PASS || 'rt-xfer-' + Math.random().toString(36).slice(2, 10);
const PORT = Number(process.env.PORT || 9232);
const ONLY = (process.env.ONLY || '').toUpperCase();

/** 本地测试文件。用 .txt 是因为任何设备都能生成，且内容一眼能认出来。 */
const TEST_NAME = 'roomtalk-xfer-test.txt';
const TEST_BODY = 'RoomTalk 传输验证 ' + Date.now() + '\n'.repeat(40) + '-- end --\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log('[xfer]', ...a);

/** 浏览器上下文挂在模块级，是为了让顶层 catch 也够得着 —— 失败路径同样必须收摊。 */
let webCtx = null;
const fails = [];
const check = (ok, label, extra = '') => {
  say((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  ' + extra : ''));
  if (!ok) fails.push(label);
};

/* ------------------------------- 安卓侧 ------------------------------- */

/**
 * 跑一条 adb 命令。
 *
 * ⚠ 带 EBUSY 重试。Windows 上短时间连开几十个 adb.exe，CreateProcess 会偶发
 *   返回 EBUSY（杀毒软件正扫这个 exe、或进程表短暂吃紧）。这类失败**和被测的
 *   功能毫无关系**，如果直接抛出去，脚本就会在毫无问题的地方报「验证失败」——
 *   这种假警报比不验证更糟，因为它会让人去查一条根本不存在的 bug。
 */
function adb(...args) {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      return execFileSync(ADB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EBUSY' && !/EBUSY/.test(String(e.message))) throw e;
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},250)'], { stdio: 'ignore' });
    }
  }
  throw lastErr;
}

/**
 * 取二进制输出（截图）。和 [adb] 一样带 EBUSY 重试 —— 拿不到截图不该把诊断本身搞挂。
 */
function adbRaw(...args) {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      return execFileSync(ADB, args, { maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EBUSY' && !/EBUSY/.test(String(e.message))) throw e;
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},250)'], { stdio: 'ignore' });
    }
  }
  throw lastErr;
}

/**
 * 取一次界面层级并解析出「资源名 → 中心坐标 / 文本」。
 * 包了重试：通话或录音时界面每秒重绘，uiautomator 等不到静止状态会直接失败。
 */
async function dumpUi(tries = 8) {
  let lastErr = '';
  for (let i = 0; i < tries; i++) {
    try {
      // ⚠ 用 `dump /dev/tty` 一次拿完：写成「dump 到文件再 cat」是两次进程启动，
      //   而上一步刚失败的原因恰恰是「短时间内开了太多 adb 进程」。
      //   一次就能拿到的东西，没理由花两次。
      const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
      if (xml.includes('<hierarchy')) {
        const out = [];
        for (const m of xml.matchAll(/<node[^>]*>/g)) {
          const n = m[0];
          const rid = /resource-id="([^"]*)"/.exec(n);
          const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);
          if (!bounds) continue;
          const text = /text="([^"]*)"/.exec(n);
          out.push({
            id: rid ? rid[1].split('/').pop() : '',
            text: text ? text[1] : '',
            x: (Number(bounds[1]) + Number(bounds[3])) >> 1,
            y: (Number(bounds[2]) + Number(bounds[4])) >> 1,
          });
        }
        if (out.length) return out;
      }
      lastErr = 'xml 里没有 <hierarchy> 或没有可解析节点';
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 160);
    }
    // ⚠ 必须留间隔：uiautomator 起一个无障碍服务要几百毫秒，
    //   连着打八次只会连着失败八次，白白把「偶发失败」放大成「必然失败」。
    await sleep(600);
  }
  throw new Error('uiautomator dump 连续失败（界面一直没静止）：' + lastErr);
}

const byId = (nodes, id) => nodes.find((n) => n.id === id);
const allText = (nodes) => nodes.map((n) => n.text).filter(Boolean).join(' | ');

function tap(x, y) { adb('shell', 'input', 'tap', String(x), String(y)); }

/**
 * 长按 = 同一点按下、停 N 毫秒、抬起。
 *
 * 用 `input swipe` 而不是 `input touchscreen tap`：只有 swipe 带 duration，
 * 而「按住说话」的整个语义就是「按了多久」。起点终点相同 → 中途的 MOVE 都在原处，
 * 不会触发我们那条「上滑取消」。
 */
function longPress(x, y, ms) {
  adb('shell', 'input', 'swipe', String(x), String(y), String(x), String(y), String(ms));
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(400);
  }
  say('  ⏱ 超时：' + label);
  return false;
}

/* ------------------------------- 网页侧 ------------------------------- */

async function connectCdp() {
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter',
    '--ignore-certificate-errors',
    '--use-fake-ui-for-media-stream',       // 自动授权麦克风
    '--use-fake-device-for-media-stream',   // 合成音频，不碰真麦克风
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=430,900',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rt-xfer-'))}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Chrome 未能就绪');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连不上')); });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: ORIGIN });

  const readyOk = await waitFor(async () => ev(
    'document.readyState === "complete" && !!window.__rt && !!document.getElementById("passphrase")',
  ).catch(() => false), 25_000, '页面就绪');
  if (!readyOk) throw new Error('页面没就绪');

  await ev(`(() => {
    document.getElementById('passphrase').value = ${JSON.stringify(PASS)};
    document.getElementById('gate-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;
  })()`);

  return { proc, ws, send, ev };
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);

  // 供「发文件」用：推到 Download 里，系统选择器一打开就能看到
  const localFile = join(tmpdir(), TEST_NAME);
  writeFileSync(localFile, TEST_BODY, 'utf8');
  adb('push', localFile, `/sdcard/Download/${TEST_NAME}`);
  say('已推送测试文件到 /sdcard/Download/' + TEST_NAME);

  const web = await connectCdp();
  webCtx = web;                       // 让下面的 catch 也够得着，失败时必须收摊
  say('网页端已进房（口令 ' + PASS + '）');

  adb('shell', 'am', 'force-stop', PKG);
  // 清一次日志缓冲：否则结尾那段「会话日志尾部」可能全是上一轮遗留的，
  // 让人拿着旧行当成这一轮的证据去分析（踩过）。
  try { adb('logcat', '-c'); } catch { /* 某些 ROM 需要权限，无所谓 */ }
  await sleep(800);
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(3500);

  let nodes = await dumpUi();
  const pass = byId(nodes, 'passInput');
  if (!pass) throw new Error('口令页没找到 passInput');
  tap(pass.x, pass.y);
  await sleep(700);
  adb('shell', 'input', 'text', PASS);
  await sleep(700);
  adb('shell', 'input', 'keyevent', '111');
  await sleep(700);
  nodes = await dumpUi();
  const enter = byId(nodes, 'enterBtn');
  tap(enter.x, enter.y);
  say('手机已提交口令，等双方接通…');

  const joined = await waitFor(async () => {
    try {
      const t = allText(await dumpUi(2));
      return t.includes('已连接');
    } catch { return false; }
  }, 30_000, '手机侧「已连接」');
  if (!joined) throw new Error('手机没能和对端接通，后续步骤没法进行');

  const webDc = await waitFor(() => web.ev('window.__rt.dcOpen').catch(() => false), 15_000, '网页 DataChannel');
  if (!webDc) throw new Error('网页侧 DataChannel 没开');

  const webVoice0 = await web.ev('window.__rt.voiceCount');
  const webFile0 = await web.ev('window.__rt.fileCount');
  const webRx0 = await web.ev('window.__rt.rxCount');
  say(`网页侧基线：voice=${webVoice0} file=${webFile0} rx=${webRx0}`);

  /* ---------------- A. 手机 → 网页：发语音 ---------------- */
  if (!ONLY || ONLY === 'A') {
    say('A. 手机按住说话 3 秒 → 网页应收到一条语音');
    nodes = await dumpUi();
    const voiceBtn = byId(nodes, 'btnVoice');
    tap(voiceBtn.x, voiceBtn.y);           // 切到语音模式
    await sleep(900);
    nodes = await dumpUi();
    const hold = byId(nodes, 'holdTalk');
    if (!hold) {
      check(false, 'A. 没找到「按住说话」按钮');
    } else {
      longPress(hold.x, hold.y, 3000);
      await sleep(4000);
      const webVoice1 = await web.ev('window.__rt.voiceCount');
      const webRx1 = await web.ev('window.__rt.rxCount');
      check(webVoice1 === webVoice0 + 1, 'A. 网页收到语音气泡', `voice ${webVoice0}→${webVoice1}`);
      check(webRx1 > webRx0, 'A. 网页 rxCount 增加', `rx ${webRx0}→${webRx1}`);
      const mime = await web.ev(
        `(() => { const a = document.querySelector('#log .msg.voice audio'); return a ? (a.src ? 'has-src' : 'no-src') : 'no-audio-el'; })()`,
      ).catch(() => 'err');
      check(mime !== 'no-audio-el', 'A. 网页那条语音带了可播放的音源', mime);

      // D. 手机自己那条语音能回放（验证 MediaPlayer 读 m4a）
      nodes = await dumpUi();
      const myDur = nodes.find((n) => /^\d+:\d\d$/.test(n.text));
      if (myDur) {
        tap(myDur.x, myDur.y);
        await sleep(1200);
        let log = '';
        try {
          log = adb('logcat', '-d', '-s', 'RoomTalk.UI');
        } catch { /* 缓冲区没内容 */ }
        check(!log.includes('播放失败'), 'D. 手机能回放自己刚录的语音',
          log.includes('播放失败') ? '（日志里有「播放失败」）' : '');
      } else {
        check(false, 'D. 手机上没找到刚发出的语音气泡');
      }
    }
  }

  /* ---------------- B. 手机 → 网页：发文件 ---------------- */
  if (!ONLY || ONLY === 'B') {
    say('B. 手机通过系统选择器发一个文件 → 网页应收到');
    nodes = await dumpUi();
    const attach = byId(nodes, 'btnAttach');
    tap(attach.x, attach.y);
    await sleep(3000);
    const picked = await pickSystemFile();
    if (!picked) {
      // ⚠ 诊断要在**按 BACK 之前**做：BACK 一按，选择器就没了，什么都拍不到。
      await diagnosePicker();
      check(false, 'B. 系统文件选择器里没选到文件');
    } else {
      await sleep(5000);
      const webFile1 = await web.ev('window.__rt.fileCount');
      const webRx2 = await web.ev('window.__rt.rxCount');
      check(webFile1 === webFile0 + 1, 'B. 网页收到文件气泡', `file ${webFile0}→${webFile1}`);
      check(webRx2 > webRx0, 'B. 网页 rxCount 又增加', `rx ${webRx0}→${webRx2}`);
    }
    // ⚠ 绝对不能无条件按 BACK：在房间里 BACK 被应用接管成**退出房间**
    //   （MainActivity.onBackPressed → session.leave()）。选择器要是已经自己关了，
    //   这一下就把手机踢出房间，后面的步骤全部作废 —— 表现出来是「C 步没收到文件」，
    //   一个纯粹由测试自己造成的假故障。所以先看一眼，选择器还在才按。
    await closePickerIfOpen();
    await sleep(600);
  }

  /* ---------------- C. 网页 → 手机：发文件 ---------------- */
  if (!ONLY || ONLY === 'C') {
    say('C. 网页发一个文件 → 手机应收到并给出可交互的气泡');
    const { root } = await web.send('DOM.getDocument');
    const q = await web.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
    await web.send('DOM.setFileInputFiles', { files: [resolve(localFile)], nodeId: q.nodeId });
    await web.ev(`document.getElementById('file-input').dispatchEvent(new Event('change', { bubbles: true }))`);

    const got = await waitFor(async () => {
      try {
        const t = allText(await dumpUi(2));
        return t.includes(TEST_NAME);
      } catch { return false; }
    }, 20_000, '手机侧出现文件名气泡');

    if (got) {
      check(true, 'C. 手机上出现了收到的文件气泡');
      const nodes2 = await dumpUi();
      const bubble = nodes2.find((n) => n.text.includes(TEST_NAME));
      tap(bubble.x, bubble.y);
      await sleep(1200);
      const dlg = allText(await dumpUi(2));
      const hasDialog = dlg.includes('另存为');
      check(hasDialog, 'C. 点气泡弹出了「打开 / 另存为」', dlg.slice(0, 80));
      // 只有弹窗真在的时候才按 BACK（房间里 BACK = 退出房间，见 closePickerIfOpen 的说明）
      if (hasDialog) { adb('shell', 'input', 'keyevent', '4'); await sleep(800); }
    } else {
      check(false, 'C. 手机没收到文件（20 秒内没出现文件名）');
    }
  }

  /* ------- E. 手机退出房间 → 该房间在本机的记忆必须跟着清掉 ------- */
  if (!ONLY || ONLY === 'E') {
    say('E. 手机按返回键退出房间 → 该房间在本机的记忆应当被清掉');
    // 先清一次日志缓冲，否则一会儿抓到的可能是上一轮留下的行
    try { adb('logcat', '-c'); } catch { /* noop */ }
    adb('shell', 'input', 'keyevent', '4');
    await sleep(2200);
    let nodes2;
    try { nodes2 = await dumpUi(3); } catch { nodes2 = []; }
    check(!!byId(nodes2, 'enterBtn'), 'E. 返回键把手机退回了口令页（还认得 enterBtn）',
      allText(nodes2).slice(0, 60));
    let tlog = '';
    try { tlog = adb('logcat', '-d', '-s', 'RoomTalk.Trust'); } catch { /* noop */ }
    check(/已清除本房间的记忆/.test(tlog), 'E. 退出房间时清掉了该房间的信任/拉黑记忆',
      tlog.split('\n').map((s) => s.trim()).filter(Boolean).slice(-1)[0] || '(没抓到日志)');
  }

  /* ---------------- 汇总 ---------------- */
  say('');
  say('================ 汇总 ================');
  if (fails.length === 0) {
    say('全部通过 ✅');
  } else {
    say(`失败 ${fails.length} 项：`);
    for (const f of fails) say('  · ' + f);
  }

  const tail = adb('logcat', '-d', '-s', 'RoomTalk.Session')
    .split('\n').filter((l) => /收到|发送|传输|分片/.test(l)).slice(-8).join('\n');
  if (tail) { say('---- 会话日志尾部 ----'); say(tail); }

  await cleanup(web);
  process.exit(fails.length ? 1 : 0);
}

/**
 * 收掉浏览器。
 *
 * ⚠ 必须**无条件**执行（成功要跑、失败也要跑）。被测站点是**线上公开站点**：
 *   一个忘了关的浏览器标签会一直挂在房间里占着 2 人房的名额，把真实用户挡在
 *   门外，而且窗口期是「直到边缘发现这条连接死了」——这段时间里对方看到的是
 *   「这个口令已经被两个人占用了」，会以为自己的口令被人猜中了。
 *   测试出问题就够糟了，不能让测试本身去伤害线上。
 */
async function cleanup(web) {
  if (!web) return;
  try {
    const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const w2 = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res) => { w2.onopen = res; w2.onerror = res; setTimeout(res, 1500); });
    w2.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(400);
  } catch { /* 已经关了 */ }
  try { web.ws.close(); } catch { /* noop */ }
  try { web.proc.kill(); } catch { /* noop */ }
  try { rmSync(join(tmpdir(), TEST_NAME), { force: true }); } catch { /* noop */ }
}

/**
 * 选择器没选到文件时，把「当下界面到底长什么样」留下来。
 *
 * 各家 ROM 的文件选择器界面差异极大（AOSP documentsui、华为文件管理、小米文档…），
 * 光看「没找到文件」这句话根本判断不出是「选择器没打开」「打开在别的目录」还是
 * 「打开的是别的应用」，所以把可见文本和一张截图都存下来。
 */
async function diagnosePicker() {
  say('  —— 选择器诊断 ——');
  try {
    const nodes = await dumpUi(3);
    const texts = [...new Set(nodes.map((n) => n.text).filter(Boolean))];
    say('    可见文本(' + texts.length + ')：' + texts.slice(0, 40).join(' | '));
    const ids = [...new Set(nodes.map((n) => n.id).filter(Boolean))];
    say('    可见 id：' + ids.slice(0, 30).join(' | '));
  } catch (e) {
    say('    界面抓不到：' + e.message);
  }
  try {
    const png = adbRaw('exec-out', 'screencap', '-p');
    writeFileSync('docs/picker-fail.png', png);
    say('    截图已存 docs/picker-fail.png');
  } catch (e) {
    say('    截图失败：' + e.message);
  }
}

/** 在当前界面里找测试文件；找到就点下去（含「还要再按一次确认」的 ROM）。 */
async function tapTestFile(nodes) {
  const f = nodes.find((n) => n.text.includes(TEST_NAME));
  if (!f) return false;
  say('  在选择器里找到文件，点它');
  tap(f.x, f.y);
  await sleep(2000);
  try {
    const after = await dumpUi(2);
    const ok = after.find((n) => ['完成', '打开', '选择', '确定', 'OK', 'Done'].includes(n.text));
    if (ok) { say('  再点一次「' + ok.text + '」'); tap(ok.x, ok.y); }
  } catch { /* 已经返回应用了 */ }
  return true;
}

/** 反复看几轮，等文件出现并点中它。 */
async function tryPick(rounds, what) {
  for (let i = 0; i < rounds; i++) {
    await sleep(1200);
    try {
      if (await tapTestFile(await dumpUi(2))) {
        say('  第 ' + (i + 1) + ' 轮在' + what + '里看到了它');
        return true;
      }
    } catch { /* 界面还没静止，下一轮 */ }
  }
  say('  ' + what + '里没有');
  return false;
}

/** 按可见文本点一下。 */
async function tapByText(re) {
  try {
    const nodes = await dumpUi(2);
    const n = nodes.find((x) => re.test(x.text));
    if (n) { say('  点「' + n.text + '」'); tap(n.x, n.y); return true; }
  } catch { /* noop */ }
  return false;
}

/**
 * 在系统文件选择器里选中那个测试文件。
 *
 * ⚠ 别退化成「只 dump 一次然后按文本找」。AOSP 的 documentsui 默认停在
 *   **「最近」**，而那一栏只列最近的照片/视频 —— 测试文件是 .txt，**在「最近」
 *   里永远不会出现**。文件明明就在手机上，界面却怎么翻都没有，表现出来就像
 *   「选择器坏了 / 我们的按钮没接上」，白白怀疑一遍自己的代码。
 *   下面按「默认视图 → 文档分类 → 根目录抽屉 → 搜索」逐级升级，每级都先等几轮。
 */
async function pickSystemFile() {
  if (await tryPick(2, '默认视图')) return true;

  // 文档分类：.txt 会出现在这里
  if (await tapByText(/^(文档|Documents)$/) && await tryPick(4, '「文档」分类')) return true;

  // 根目录抽屉 → 下载
  say('  试试从左边缘拉出根目录抽屉');
  adb('shell', 'input', 'swipe', '2', '1200', '700', '1200', '320');
  await sleep(1200);
  if (await tapByText(/^(下载|Downloads|内部存储|Internal storage)$/) && await tryPick(4, '「下载」目录')) return true;

  // 搜索：最不依赖 ROM 的一招
  if (await searchInPicker() && await tryPick(4, '搜索结果')) return true;

  return false;
}

/**
 * 选择器还开着就按 BACK 关掉它；已经关了则什么都不做。
 *
 * ⚠ 判据必须靠界面特征，不能靠「上一步返回了什么」——选择器有些实现选完自己就关了。
 */
async function closePickerIfOpen() {
  let nodes;
  try { nodes = await dumpUi(2); } catch { return false; }
  const text = nodes.map((n) => n.text).join('|');
  const ids = nodes.map((n) => n.id);
  const isPicker = /最近|浏览其他应用中的文件/.test(text)
    || ids.includes('drawer_layout') || ids.includes('dir_list');
  if (!isPicker) return false;
  say('  选择器还开着，按 BACK 退出');
  adb('shell', 'input', 'keyevent', '4');
  await sleep(1200);
  return true;
}

/** 用选择器自带的搜索框直接找文件名。 */
async function searchInPicker() {
  try {
    const nodes = await dumpUi(2);
    const s = nodes.find((n) => n.id === 'option_menu_search')
      || nodes.find((n) => /搜索|Search/.test(n.text));
    if (!s) return false;
    say('  用搜索框找文件名');
    tap(s.x, s.y);
    await sleep(1200);
    adb('shell', 'input', 'text', TEST_NAME);
    await sleep(1800);
    return true;
  } catch { return false; }
}

main().catch(async (e) => {
  console.error('[xfer] 失败:', e.message);
  // ⚠ 失败路径**同样**要收摊：忘关的浏览器会一直占着这间房的名额挡住真实用户。
  await cleanup(webCtx);
  process.exit(1);
});
