'use strict';
/* ===========================================================================
   量一下「幽灵连接」能占住房间多久。

   背景：房间上限是 2，服务端靠「连接还在不在」来算人数。而客户端如果是被强杀
   （force-stop / 崩溃 / 断网），它发不出 close 帧，服务端只能等运行时自己发现。
   这段时间里，真正的用户会被拒以「这个口令已经被两个人占用了」—— 明明没人用。

   这个脚本模拟「连上、进房、然后粗暴掐断线路」（不发 close 帧，直接 RST），
   之后每 10 秒探一次，把「多久才腾出来」量成秒数。

   用法：
     node test/ghost-probe.mjs 1234
   =========================================================================== */

import { pbkdf2Sync } from 'node:crypto';

const URL_WS = process.env.SIGNAL_URL || 'wss://8.xn--fiqs8s/ws';
const pass = process.argv[2] || '1234';
const room = pbkdf2Sync(pass, 'roomtalk-v1', 100000, 32, 'sha256').toString('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 占一个位子，然后**粗暴**断开（destroy 底层 socket → 发 RST 而不是 close 帧）。 */
function squat(count) {
  return new Promise((resolve) => {
    const opened = [];
    let joined = 0;
    for (let i = 0; i < count; i++) {
      const ws = new WebSocket(URL_WS);
      opened.push(ws);
      ws.onopen = () => ws.send(JSON.stringify({
        type: 'join', room, clientId: `ghost-${i}-${Date.now()}`, name: `幽灵${i + 1}`,
      }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'room-joined') { joined++; if (joined === count) resolve(opened); }
        if (m.type === 'room-error') { console.log('  占位失败：', m.code, m.reason); resolve(opened); }
      };
    }
  });
}

/** 房间还满着吗？ */
function roomFull() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_WS);
    const fin = (v) => { try { ws.close(); } catch { /* noop */ } resolve(v); };
    const t = setTimeout(() => fin(null), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'join', room, clientId: 'watch-' + Date.now(), name: 'watcher',
    }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'room-joined') { clearTimeout(t); fin(false); }
      else if (m.type === 'room-error') { clearTimeout(t); fin(m.code === 'room-full'); }
    };
    ws.onerror = () => { clearTimeout(t); fin(null); };
  });
}

console.log('[ghost] 房间', pass, '→', room);
console.log('[ghost] 先占满 2 个位子…');
const socks = await squat(2);
await sleep(1500);

console.log('[ghost] 确认现在满了：', await roomFull() ? '满 ✅' : '没满 ❓');

console.log('[ghost] 粗暴掐断（不优雅关闭）…');
for (const ws of socks) {
  try { ws._socket && ws._socket.destroy(); } catch { /* noop */ }
  try { ws.close(); } catch { /* noop */ }
}

const t0 = Date.now();
let freed = null;
for (let i = 0; i < 30; i++) {          // 最多等 30 轮 × 10s = 5 分钟
  await sleep(10_000);
  const full = await roomFull();
  const el = Math.round((Date.now() - t0) / 1000);
  console.log(`[ghost] +${el}s  还满着？ ${full === null ? '探测失败' : (full ? '是' : '否')}`);
  if (full === false) { freed = el; break; }
}

console.log(freed === null
  ? '[ghost] 5 分钟内一直没腾出来 ❌（说明僵尸会长期占位）'
  : `[ghost] 结论：掐断后 ${freed} 秒才腾出来`);
process.exit(0);
