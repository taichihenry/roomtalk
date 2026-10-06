'use strict';
/* ===========================================================================
   RoomTalk · 截图（视觉验收用）
   ---------------------------------------------------------------------------
   跑之前需要 wrangler dev 在 8787 上。
   产出 docs/shot-gate.png（入口页，含页脚联系方式）和 docs/shot-room.png（房间工具栏）。

   运行：node test/shot.mjs
   =========================================================================== */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const CHROME = 'E:/softs/Chrome153_AllNew_2026.9.12/App/chrome.exe';
const ORIGIN = process.env.RT_ORIGIN || 'http://127.0.0.1:8787';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const pending = new Map();
let ws;

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

async function shoot(name, fullPage) {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !!fullPage,
  });
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('  ✓', file);
}

const profile = mkdtempSync(join(tmpdir(), 'rt-shot-'));
mkdirSync(OUT, { recursive: true });

spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-features=Translate,MediaRouter',
  '--ignore-certificate-errors',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=430,940',
  '--remote-debugging-port=9331',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

/* 等调试端口 */
let target = null;
for (let i = 0; i < 80 && !target; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9331/json/list')).json();
    target = list.find((t) => t.type === 'page');
  } catch { /* 还没起来 */ }
  if (!target) await sleep(200);
}
if (!target) throw new Error('Chrome 没起来');

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连不上')); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 940, deviceScaleFactor: 2, mobile: true });

await send('Page.navigate', { url: ORIGIN });
for (let i = 0; i < 80; i++) {
  if (await evaluate('document.readyState === "complete" && !!document.getElementById("passphrase")').catch(() => false)) break;
  await sleep(200);
}
await sleep(400);
console.log('入口页：');
await shoot('shot-gate.png', true);

/* 进房间，看工具栏上的画质下拉 */
await evaluate(`(() => {
  const p = document.getElementById('passphrase');
  p.value = 'shot-' + Math.random().toString(36).slice(2, 8);
  p.type = 'text';
  document.getElementById('gate-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`);
for (let i = 0; i < 80; i++) {
  if (await evaluate('!document.getElementById("room").hidden').catch(() => false)) break;
  await sleep(200);
}
await sleep(900);
console.log('房间页：');
await shoot('shot-room.png', false);

const info = await evaluate(`(() => {
  const s = document.getElementById('video-quality');
  const c = document.querySelector('.contact');
  return {
    selectVisible: !!s && s.offsetWidth > 0,
    quality: window.__rt ? __rt.quality : null,
    options: s ? [...s.options].map(o => o.textContent) : null,
    contact: c ? c.textContent.replace(/\\s+/g, ' ').trim() : null,
  };
})()`);
console.log('\n实测：', JSON.stringify(info, null, 2));

try {
  const v = await (await fetch('http://127.0.0.1:9331/json/version')).json();
  const w2 = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res) => { w2.onopen = res; w2.onerror = res; setTimeout(res, 1500); });
  w2.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await sleep(400);
} catch { /* 已经退了 */ }
process.exit(0);
