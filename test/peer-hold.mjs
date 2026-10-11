'use strict';
/* ===========================================================================
   「房间里那个另一个人」—— 起一个真 Chrome 进房并挂着，用来给安卓 App 当对手。

   为什么要它：安卓那个 native abort 只在 `onConnectionChange(CONNECTED)` 时触发，
   而单机（房里没人）时 `startCall()` 会先在 `dcReady()` 就 return，根本走不到建
   PeerConnection —— 只测单机等于没测。必须有一个真 peer 在房里把连接拉起来。

   复用 test/e2e.mjs 的 Chrome 启动参数（三个本机坑都在那里绕开了）：
     · 这份 Chrome(153) **加 --no-proxy-server 就启动即退**，所以不加
     · 系统代理会劫持 localhost，Node 侧先清环境变量
     · 关掉 HTTP 缓存，免得拿到旧的 app.js

   用法：
     PASS=1234 node test/peer-hold.mjs                    # 打线上 https://8.中国
     RT_ORIGIN=http://127.0.0.1:8787 PASS=x node test/peer-hold.mjs
   =========================================================================== */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const CHROME_CANDIDATES = [
  'E:/softs/vpn/Chrome153_AllNew_2026.9.12/App/chrome.exe',
  'E:/softs/Chrome153_AllNew_2026.9.12/App/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const CHROME = process.env.CHROME
  || CHROME_CANDIDATES.find((p) => existsSync(p))
  || CHROME_CANDIDATES[0];
const ORIGIN = process.env.RT_ORIGIN || 'https://8.中国';
const PASS = process.env.PASS || '1234';
const HOLD = Number(process.env.HOLD || 90);
const PORT = Number(process.env.PORT || 9231);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[peer]', ...a);

async function main() {
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);
  const profileDir = mkdtempSync(join(tmpdir(), 'rt-peer-'));
  log('Chrome:', CHROME);
  log('站点:', ORIGIN, ' 口令:', PASS, ' 保持:', HOLD + 's');

  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter',
    '--ignore-certificate-errors',
    '--use-fake-ui-for-media-stream',      // 自动授权麦克风/摄像头
    '--use-fake-device-for-media-stream',  // 合成音视频，不碰真实设备
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=430,900',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
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
  if (!target) throw new Error('Chrome 未能就绪（port ' + PORT + '）');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('无法连接 CDP'));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' :: ' +
        (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: ORIGIN });

  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await ev(
      'document.readyState === "complete" && !!window.__rt && !!document.getElementById("passphrase")',
    ).catch(() => false);
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error('页面未就绪（100 次轮询后仍无 #passphrase / __rt）');

  await ev(`(() => {
    const p = document.getElementById('passphrase');
    p.value = ${JSON.stringify(PASS)};
    document.getElementById('gate-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }));
    return true;
  })()`);
  log('已提交口令，等对端接入…');

  // CALL_AT>0 时，进房第 N 秒自动点一次「发起语音通话」——
  // 用来验证对端（安卓）能不能收到呼叫信令并弹出接听浮层。
  const callAt = Number(process.env.CALL_AT || 0);
  const callId = process.env.CALL_ID || 'btn-call-audio';
  let called = false;

  // ANSWER_AT>0 时自动接听来电。用来把通话真正接起来 —— 有些东西（麦克风开关
  // 的两个状态、通话计时）只有接听之后才存在，光靠「正在呼叫」那一屏验不了。
  const answerAt = Number(process.env.ANSWER_AT || 0);
  let answered = false;

  const t0 = Date.now();
  while (Date.now() - t0 < HOLD * 1000) {
    if (answerAt > 0 && !answered) {
      const ringing = await ev(
        '(() => { const r = document.getElementById("ring"); return !!r && !r.hidden; })()',
      ).catch(() => false);
      if (ringing) {
        const r = await ev(`(() => {
          const b = document.getElementById('ring-accept');
          if (!b) return 'no-btn';
          b.click();
          return b.id;
        })()`).catch((e) => 'ERR ' + e.message);
        answered = true;
        log('已点「接听」:', r);
      }
    }
    if (callAt > 0 && !called && Date.now() - t0 >= callAt * 1000) {
      called = true;
      const r = await ev(`(() => {
        const b = document.getElementById(${JSON.stringify(callId)});
        if (!b) return 'no-btn';
        b.click();
        return b.id;
      })()`).catch((e) => 'ERR ' + e.message);
      log('已点「发起语音通话」:', r);
    }
    const snap = await ev(`(() => {
      const body = (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 150);
      const room = document.getElementById('room');
      return JSON.stringify({
        roomShown: room ? getComputedStyle(room).display !== 'none' : null,
        body,
      });
    })()`).catch((e) => 'ERR ' + e.message);
    log(String(Math.round((Date.now() - t0) / 1000)) + 's', snap);
    await sleep(5000);
  }

  try {
    const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const w2 = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res) => { w2.onopen = res; w2.onerror = res; setTimeout(res, 1500); });
    w2.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(400);
  } catch { /* 已经没了 */ }
  try { ws.close(); } catch { /* noop */ }
  try { proc.kill(); } catch { /* 启动器早已退出 */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* noop */ }
  log('结束');
}

main().catch((e) => { console.error('[peer] 失败:', e.message); process.exit(1); });
