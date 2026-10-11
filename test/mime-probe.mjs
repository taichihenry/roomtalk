'use strict';
/* ===========================================================================
   探测本机 Chrome 的 MediaRecorder 能录哪些音频格式。

   为什么需要：网页端录音优先选 `audio/webm;codecs=opus`，而**安卓的
   MediaRecorder 产不出 WebM/Opus**（它只会 mp4/aac、ogg/opus 那几样）。
   语音消息要在两端互相能播，就必须先找到「两边都录得出、也都放得了」的交集。
   这个脚本把 Chrome 那边的能力摊开，避免靠猜。

   用法：
     node test/mime-probe.mjs
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
const PORT = Number(process.env.PORT || 9240);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 候选清单：前四个是网页端 pickVoiceMime 已经会挑的，后面是安卓原生能产出的。 */
const MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/aac',
  'audio/mpeg',
  'audio/3gpp',
  'video/webm;codecs=vp8,opus',
];

async function main() {
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);
  const profileDir = mkdtempSync(join(tmpdir(), 'rt-mime-'));
  console.log('[mime] Chrome:', CHROME);

  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--ignore-certificate-errors',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('无法连接 CDP')); });

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
  await send('Page.navigate', { url: ORIGIN });

  for (let i = 0; i < 100; i++) {
    const ok = await ev('document.readyState === "complete"').catch(() => false);
    if (ok) break;
    await sleep(200);
  }

  const raw = await ev(`(() => {
    const out = { hasMediaRecorder: !!window.MediaRecorder, ua: navigator.userAgent, list: {} };
    if (window.MediaRecorder) {
      for (const m of ${JSON.stringify(MIMES)}) {
        try { out.list[m] = MediaRecorder.isTypeSupported(m); }
        catch (e) { out.list[m] = 'ERR ' + e.message; }
      }
    }
    return JSON.stringify(out);
  })()`);

  const data = JSON.parse(raw);
  console.log('[mime] MediaRecorder 存在:', data.hasMediaRecorder);
  console.log('[mime] UA:', data.ua);
  console.log('[mime] ---- 各格式支持情况 ----');
  for (const m of MIMES) {
    const v = data.list[m];
    console.log('[mime]  ' + (v === true ? '✔' : '✘') + '  ' + m + (v === 'true' ? '' : v === true ? '' : '   -> ' + v));
  }

  try { proc.kill(); } catch { /* noop */ }
  try { ws.close(); } catch { /* noop */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* noop */ }
  // ⚠ 必须硬退：CDP 的 WebSocket 只要还挂着，Node 的事件循环就不会空 ——
  //   脚本会「打印完了但不结束」，在 CI/工具里表现为超时被 SIGTERM。
  process.exit(0);
}

main().catch((e) => { console.error('[mime] 失败:', e.message); process.exit(1); });
