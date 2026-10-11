'use strict';
/* ===========================================================================
   直接问信令服务器：这间房现在有几个人？都是谁？

   为什么不走浏览器：出问题时我们要的是**服务端眼里的房间状态**，而浏览器会把
   事情搅浑（它自己就是嫌疑对象之一）。用裸 WebSocket 直连，只做 join 一件事，
   返回什么就打印什么 —— 包括 room-error 里的 count/limit，那是服务端亲口说的数字。

   用法：
     node test/room-probe.mjs 1234            # 只探一次
     node test/room-probe.mjs 1234 --watch    # 每 15 秒探一次，看什么时候腾出来
     node test/room-probe.mjs 1234 --cid XXX  # 指定 clientId（复用它就能抢占自己的旧连接）
   =========================================================================== */

import { createHash, pbkdf2Sync } from 'node:crypto';

const URL_WS = process.env.SIGNAL_URL || 'wss://8.xn--fiqs8s/ws';

/**
 * 与网页端 / 安卓端逐字一致的房间号派生：
 * PBKDF2-HMAC-SHA256(口令, salt='roomtalk-v1', 100000 轮, 32 字节) → 十六进制。
 * ⚠ 这三样（salt、轮数、输出长度）任何一处不一致，算出来的就是另一间房。
 */
function deriveRoom(pass) {
  return pbkdf2Sync(pass, 'roomtalk-v1', 100000, 32, 'sha256').toString('hex');
}

const pass = process.argv[2] || '1234';
const watch = process.argv.includes('--watch');
const cidIdx = process.argv.indexOf('--cid');
const clientId = cidIdx > 0 ? process.argv[cidIdx + 1] : 'probe-' + createHash('sha1')
  .update(String(Math.random())).digest('hex').slice(0, 12);

const room = deriveRoom(pass);

/** 探一次。返回 {type, ...} 或 {type:'timeout'} */
function probe() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_WS);
    const done = (v) => { try { ws.close(); } catch { /* noop */ } resolve(v); };
    const timer = setTimeout(() => done({ type: 'timeout' }), 12_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room, clientId, name: 'probe' }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'self') return;                 // 握手自带的一条，不关心
      clearTimeout(timer);
      if (m.type === 'room-joined' || m.type === 'peers') {
        // 先拿到 room-joined 就再等一拍 peers（两条是连着来的）
        if (m.type === 'room-joined') { ws._joined = m; return; }
        done({ ...(ws._joined || {}), ...m });
      } else {
        done(m);
      }
    };
    ws.onerror = () => { clearTimeout(timer); done({ type: 'error' }); };
  });
}

async function once() {
  const r = await probe();
  const at = new Date().toTimeString().slice(0, 8);
  if (r.type === 'peers') {
    const names = (r.peers || []).map((p) => p.name || '(无名)');
    console.log(`[probe ${at}] 房间 ${pass} → 进去了（host=${!!r.host}），房里已有 ${names.length} 人：${names.join(', ') || '（空房）'}`);
    return { full: false, count: names.length, names };
  }
  if (r.type === 'room-error') {
    console.log(`[probe ${at}] 房间 ${pass} → 被拒：${r.code}  count=${r.count} limit=${r.limit}`);
    console.log(`            服务端说：${r.reason}`);
    return { full: r.code === 'room-full', count: r.count, names: [] };
  }
  console.log(`[probe ${at}] 房间 ${pass} → ${r.type}`);
  return { full: false, count: -1, names: [] };
}

if (!watch) {
  const r = await once();
  process.exit(r.full ? 3 : 0);
}

console.log(`[probe] 房间号 ${room}`);
let n = 0;
let free = false;
while (n < 40) {
  const r = await once();
  n++;
  if (!r.full) { free = true; break; }
  await new Promise((res) => setTimeout(res, 15_000));
}
console.log(free ? '[probe] 已腾出 ✅' : '[probe] 一直占着（探了 40 次）');
process.exit(0);
