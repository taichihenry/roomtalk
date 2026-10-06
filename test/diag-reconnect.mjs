'use strict';
/* 重连专项诊断：记录 B 在掉线前后 status 的每一次变化 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) delete process.env[k];

const CHROME = 'E:/softs/Chrome153_AllNew_2026.9.12/App/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8787';
const PASS = 'diag-' + Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'rt-diag-'));

class P {
  constructor() { this.n = 0; this.pending = new Map(); }
  async open(port, dir) {
    spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
      '--ignore-certificate-errors', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
    let t = null;
    for (let i = 0; i < 80 && !t; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      } catch { /* 还没起来 */ }
      if (!t) await sleep(200);
    }
    if (!t) throw new Error('Chrome 未就绪 ' + port);
    this.port = port;
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    };
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Page.navigate', { url: ORIGIN });
    for (let i = 0; i < 60; i++) {
      if (await this.ev('!!window.__rt && document.readyState === "complete"').catch(() => false)) break;
      await sleep(200);
    }
    return this;
  }
  send(method, params = {}) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async close() {
    try {
      const i = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
      const ws = new WebSocket(i.webSocketDebuggerUrl);
      await new Promise((r) => { ws.onopen = r; ws.onerror = r; setTimeout(r, 1200); });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(300);
    } catch { /* noop */ }
  }
}

const A = await new P().open(9222, join(tmp, 'a'));
const B = await new P().open(9223, join(tmp, 'b'));

const enter = (p) => p.ev(`(()=>{document.getElementById('passphrase').value=${JSON.stringify(PASS)};
  document.getElementById('gate-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));return 1})()`);

// 在 B 上挂状态变化记录器
const startLog = (p) => p.ev(`(()=>{ window.__log = [];
  const el = document.getElementById('status');
  window.__log.push('T0 ' + el.textContent);
  new MutationObserver(()=>window.__log.push(Math.round(performance.now()) + ' | ' + el.textContent))
    .observe(el, {childList:true, characterData:true, subtree:true});
  return 'ok'; })()`);

await startLog(A);
await startLog(B);

await enter(A);
await sleep(1500);
await enter(B);

for (let i = 0; i < 60; i++) {
  if ((await A.ev('__rt.status')).includes('已连接') && (await B.ev('__rt.status')).includes('已连接')) break;
  await sleep(300);
}
console.log('接通后 A=' + await A.ev('__rt.status') + '  B=' + await B.ev('__rt.status'));

console.log('\n--- 触发 B 掉线 ---');
const hasHook = await B.ev('typeof window.__rt.__dropSocket');
console.log('__dropSocket 存在？' + hasHook);

const t0 = Date.now();
await B.ev('window.__rt.__dropSocket(), 1');
console.log('已调用，等待 20 秒观察…\n');

for (let i = 0; i < 20; i++) {
  await sleep(1000);
  const b = await B.ev('({s:__rt.status, c:__rt.connectionState, dc:__rt.dcOpen})').catch((e) => ({ err: e.message }));
  const a = await A.ev('({s:__rt.status, c:__rt.connectionState, dc:__rt.dcOpen})').catch((e) => ({ err: e.message }));
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] B=${JSON.stringify(b)}  A=${JSON.stringify(a)}`);
}

console.log('\n--- B 的 status 变化历史 ---');
console.log((await B.ev('window.__log')).join('\n'));
console.log('\n--- A 的 status 变化历史 ---');
console.log((await A.ev('window.__log')).join('\n'));

await A.close();
await B.close();
process.exit(0);
