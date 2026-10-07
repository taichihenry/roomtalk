'use strict';
/* ===========================================================================
   RoomTalk · Durable Object 离线逻辑测试
   ---------------------------------------------------------------------------
   不需要 wrangler / workerd，用一套最小 shim 直接跑 DO 的逻辑。

   ⚠ 关键：deserializeAttachment() 必须做**深拷贝**。
     真实 DO 每次调用都返回一个新对象；如果代码改了对象却没写回
     serializeAttachment，线上会静默丢状态。而浅拷贝的假 shim
     **永远测不出来**（它返回同一个引用，改动「看起来」生效了）。

   运行：node cloudflare/test/do-sim.js
   =========================================================================== */

/* ------------------------------ shim ------------------------------ */

class FakeWS {
  constructor(tag) {
    this.tag = tag;
    this.readyState = 1;
    this._att = null;
    this.sent = [];
    this.closeCode = null;
  }
  serializeAttachment(a) { this._att = structuredClone(a); }
  deserializeAttachment() { return this._att ? structuredClone(this._att) : null; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.closeCode = code ?? 1000; this.readyState = 3; }
  /** 取走并清空已发送的消息，方便「只看这一轮」 */
  drain() { const s = this.sent; this.sent = []; return s; }
}

class FakeCtx {
  constructor() { this.ws = []; this.autoResponse = null; }
  acceptWebSocket(ws) { this.ws.push(ws); }
  /** 真实 DO 的 getWebSockets 会包含「正在关闭」的连接，直到 close 事件处理完 */
  getWebSockets() { return this.ws.slice(); }
  setWebSocketAutoResponse(pair) { this.autoResponse = pair; }
  remove(ws) { const i = this.ws.indexOf(ws); if (i >= 0) this.ws.splice(i, 1); }
}

class FakePair {
  constructor() { this[0] = new FakeWS('client'); this[1] = new FakeWS('server'); }
}

globalThis.WebSocketPair = FakePair;
globalThis.WebSocketRequestResponsePair = class {
  constructor(req, res) { this.request = req; this.response = res; }
};

// Node 的 Response 不接受 101（informational），换成能表达它的替身
const RealResponse = globalThis.Response;
globalThis.Response = function (body, init) {
  if (init && init.status === 101) {
    return { status: 101, webSocket: init.webSocket, headers: init.headers, _raw: body };
  }
  return new RealResponse(body, init);
};

/* ------------------------------ 载入被测对象 ------------------------------ */

const { SignalRoom, BASE_ICE } = await import('../src/room.js');

/* ------------------------------ 断言工具 ------------------------------ */

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('   \u2713 ' + name); }
  else { fail++; console.log('   \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
}

function section(t) { console.log('\n== ' + t + ' =='); }

/* ------------------------------ 工具 ------------------------------ */

const ROOM_A = 'a'.repeat(32);
const ROOM_B = 'b'.repeat(32);

const req = (upgrade = 'websocket') => ({
  headers: { get: (k) => (k.toLowerCase() === 'upgrade' ? upgrade : null) },
});

/** 建一条连接，返回 { ws, self } */
async function open(room, env = {}) {
  const ctx = room.ctx;
  const res = await room.fetch(req());
  if (res.status !== 101) return { res, ws: null };
  const ws = ctx.getWebSockets().slice(-1)[0];
  const self = ws.sent.find((m) => m.type === 'self');
  return { res, ws, self };
}

async function send(room, ws, msg) {
  await room.webSocketMessage(ws, JSON.stringify(msg));
}

const types = (arr) => arr.map((m) => m.type);

/* ================================================================ */

async function main() {
  /* ---------------------------- 1. 建连 ---------------------------- */
  section('1. 连接建立');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const { res, ws, self } = await open(room);
    check('fetch 返回 101 升级', res.status === 101);
    check('收到 self 消息', !!self);
    check('self 带 peerId', typeof self?.peerId === 'string' && self.peerId.length > 10);
    check('self 下发 STUN 列表', Array.isArray(self?.iceServers) && self.iceServers.length > 0);
    check('STUN 首选 Cloudflare（国内可达的排前面）', self?.iceServers?.[0]?.urls?.includes('cloudflare'));
    check('self 不泄露任何 IP', !JSON.stringify(self).match(/\d+\.\d+\.\d+\.\d+/));

    const bad = await room.fetch(req('not-websocket'));
    check('非 WS 请求被拒（426）', bad.status === 426, bad.status);
  }

  /* ---------------------------- 2. 双人成房 ---------------------------- */
  section('2. 两个人凭同一口令进同一间房');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca', name: 'A' });
    check('A 进房成功', types(a.ws.sent).includes('room-joined'), types(a.ws.sent));
    check('A 独自在房里，peers 为空', a.ws.sent.some((m) => m.type === 'peers' && m.peers.length === 0));
    a.ws.drain();

    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb', name: 'B' });

    check('B 看到房里已有 A', b.ws.sent.some((m) => m.type === 'peers' && m.peers.length === 1));
    check('A 收到 B 进房通知', a.ws.sent.some((m) => m.type === 'peer-joined'));
    check('通知里只有 id/name，没有 IP', (() => {
      const p = a.ws.sent.find((m) => m.type === 'peer-joined')?.peer;
      return p && Object.keys(p).sort().join(',') === 'id,name';
    })());
    check('两边拿到的是同一个房间号', (() => {
      const bRoom = b.ws.sent.find((m) => m.type === 'peers')?.room;
      const aRoom = a.ws.sent.find((m) => m.type === 'peer-joined')?.room;
      return bRoom === ROOM_A && aRoom === ROOM_A;
    })());
  }

  /* ---------------------------- 3. 满员拦截 ---------------------------- */
  section('3. 第三个人进不来（口令被转发也挡得住）');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });
    b.ws.drain();
    a.ws.drain();

    const c = await open(room);
    await send(room, c.ws, { type: 'join', room: ROOM_A, clientId: 'cc' });

    const err = c.ws.sent.find((m) => m.type === 'room-error');
    check('C 被拒（room-full）', err?.code === 'room-full', c.ws.sent);
    check('拒绝回执带 count/limit', err?.count === 2 && err?.limit === 2, err);
    check('C 没有混进房间（A/B 无感知）', !a.ws.sent.some((m) => m.type === 'peer-joined') && !b.ws.sent.some((m) => m.type === 'peer-joined'));
  }

  /* ---------------------------- 4. 转发的安全边界 ---------------------------- */
  section('4. 信令转发的安全边界');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });
    const aId = a.ws.deserializeAttachment().peerId;
    a.ws.drain();
    b.ws.drain();

    // 正常转发
    await send(room, b.ws, { type: 'signal', room: ROOM_A, to: aId, payload: { hello: 1 } });
    check('同房间内正常转发', a.ws.sent.some((m) => m.type === 'sig' && m.payload.hello === 1));
    check('转发时带上了发送者身份', a.ws.sent.find((m) => m.type === 'sig')?.senderId === b.ws.deserializeAttachment().peerId);
    a.ws.drain();

    // 局外人：C 自己开一间房，然后伪造往 ROOM_A 投递
    const c = await open(room);
    await send(room, c.ws, { type: 'join', room: ROOM_B, clientId: 'cc' });
    a.ws.drain();
    await send(room, c.ws, { type: 'signal', room: ROOM_A, to: aId, payload: { evil: 1 } });
    check('不在该房间的人无法投递（否则可插进正在进行的通话）', !a.ws.sent.some((m) => m.type === 'sig'));

    // 合法房间里伪造一个不存在的目标
    await send(room, b.ws, { type: 'signal', room: ROOM_A, to: 'no-such-peer', payload: { evil: 2 } });
    check('伪造不存在的 peerId 不会被投递', !a.ws.sent.some((m) => m.type === 'sig'));

    // 非法房间号格式
    const d = await open(room);
    await send(room, d.ws, { type: 'join', room: 'NOT-A-HEX-ROOM!!', clientId: 'cd' });
    check('非法房间号被拒（bad-room）', d.ws.sent.some((m) => m.type === 'room-error' && m.code === 'bad-room'));

    // 自己给自己发
    a.ws.drain();
    await send(room, a.ws, { type: 'signal', room: ROOM_A, to: aId, payload: { self: 1 } });
    check('不能给自己发（目标必须是对端）', !a.ws.sent.some((m) => m.type === 'sig'));
  }

  /* ---------------------------- 5. 断线 / 离开 ---------------------------- */
  section('5. 断线与离开');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });
    a.ws.drain();

    // 主动离开
    await send(room, b.ws, { type: 'leave', room: ROOM_A });
    check('主动退房会通知对方', a.ws.sent.some((m) => m.type === 'peer-left'));
    a.ws.drain();
    b.ws.drain();

    // 断线
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });
    a.ws.drain();
    b.ws.readyState = 3;
    await room.webSocketClose(b.ws);
    check('断线会通知对方', a.ws.sent.some((m) => m.type === 'peer-left'));

    // 限流桶必须随连接一起回收（Map 的 key 是 ws 对象，不删就是纯泄漏）
    // 注意只查已断开的那条：同房间的 A 还活着，它的桶本来就该在
    check('断线连接的限流桶被回收', !room._rate.has(b.ws), room._rate.size);
  }

  /* ---------------------------- 6. 重连踢掉自己的僵尸连接 ---------------------------- */
  section('6. 断网重连：踢掉自己的旧连接');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });
    b.ws.drain();

    // A 的网络假死：TCP 还没断，readyState 仍是 1，但它已占着名额
    const a2 = await open(room);
    await send(room, a2.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });

    check('A 的新连接挤得进来（否则刷新页面会把自己挡在门外）', a2.ws.sent.some((m) => m.type === 'room-joined'), types(a2.ws.sent));
    check('旧连接被主动关闭', a.ws.closeCode === 4001, a.ws.closeCode);
    check('B 收到「旧的走了、新的来了」', types(b.ws.sent).includes('peer-left') && types(b.ws.sent).includes('peer-joined'), types(b.ws.sent));
    check('房间里仍然是 2 个人', [...room._roomsIndex().get(ROOM_A) || []].length === 2);
  }

  /* ---------------------------- 7. 休眠重建 ---------------------------- */
  section('7. Durable Object 休眠后房间表重建');
  {
    const ctx = new FakeCtx();
    let room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });

    // 模拟休眠唤醒：同一个 ctx，全新的实例（内存清空、WS 还在）
    room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    check('房间表从 attachment 重建成功', room._roomsIndex().get(ROOM_A)?.size === 2, room._roomsIndex().get(ROOM_A)?.size);

    // 醒来后满员判定依然有效
    const c = await open(room);
    await send(room, c.ws, { type: 'join', room: ROOM_A, clientId: 'cc' });
    check('醒来后满员判定仍然有效', c.ws.sent.some((m) => m.type === 'room-error' && m.code === 'room-full'));

    // 醒来后转发依然有效
    const aId = a.ws.deserializeAttachment().peerId;
    a.ws.drain();
    await send(room, b.ws, { type: 'signal', room: ROOM_A, to: aId, payload: { after: 'wake' } });
    check('醒来后信令转发正常', a.ws.sent.some((m) => m.type === 'sig' && m.payload.after === 'wake'));
  }

  /* ---------------------------- 8. 限额与保活 ---------------------------- */
  section('8. 全局闸门与保活');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, { MAX_CONNECTIONS: '2' });
    room.ctx = ctx;
    await open(room);
    await open(room);
    const res = await room.fetch(req());
    check('连接数到顶后回 503（而非静默断开）', res.status === 503, res.status);

    const ctx2 = new FakeCtx();
    const room2 = new SignalRoom(ctx2, { MAX_ROOMS_TOTAL: '1' });
    room2.ctx = ctx2;
    const x = await open(room2);
    await send(room2, x.ws, { type: 'join', room: ROOM_A, clientId: 'cx' });
    const y = await open(room2);
    await send(room2, y.ws, { type: 'join', room: ROOM_B, clientId: 'cy' });
    check('房间数到顶后拒绝新建', y.ws.sent.some((m) => m.type === 'room-error' && m.code === 'server-full'));
    const z = await open(room2);
    await send(room2, z.ws, { type: 'join', room: ROOM_A, clientId: 'cz' });
    check('但已在册的房间仍能进（否则房间一满所有人被锁死）', z.ws.sent.some((m) => m.type === 'room-joined'));
  }

  /* ---------------------------- 9. 保活字面量（最隐蔽的一条） ---------------------------- */
  section('9. 保活消息字面量精确匹配');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;
    await room.fetch(req());

    const registered = ctx.autoResponse;
    check('注册了自动响应', !!registered);
    // ⚠ 这是全项目唯一「错了也不报错」的检查项：
    //   差一个空格，自动响应就静默失效 —— 功能正常，只是开始按满额计费。
    check('前端 ping 的序列化结果与注册字面量逐字相等',
      JSON.stringify({ type: 'ping' }) === registered.request,
      { frontend: JSON.stringify({ type: 'ping' }), server: registered.request });
    check('pong 字面量一致', registered.response === '{"type":"pong"}', registered.response);
  }

  /* ---------------------------- 10. 限流 ---------------------------- */
  section('10. 滥用防护');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;
    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    a.ws.drain();

    const raw = JSON.stringify({ type: 'ping' });
    let allowed = 0;
    for (let i = 0; i < 400; i++) if (room._allowMessage(a.ws, raw)) allowed++;
    check('超过阈值后被限流', allowed <= 200, allowed);

    const b = await open(room);
    b.ws.drain();
    for (let i = 0; i < 400; i++) await room.webSocketMessage(b.ws, raw);
    check('超限的连接被断开', b.ws.closeCode === 1008, b.ws.closeCode);
  }

  /* ---------------------------- 11. 请出房间 ---------------------------- */
  section('11. 请出房间（口令被别人拿到时唯一的出路）');
  {
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    // C 拿到了同一个口令，抢先占了第二个位子
    const c = await open(room);
    await send(room, c.ws, { type: 'join', room: ROOM_A, clientId: 'cc' });
    const cId = c.ws.deserializeAttachment().peerId;

    // 房主判定：第一个进房的人是房主
    check('第一个进房的人拿到 host=true',
      a.ws.sent.find((m) => m.type === 'room-joined')?.host === true,
      a.ws.sent.find((m) => m.type === 'room-joined'));
    check('后进房的人拿到 host=false（没有请人出去的权限）',
      c.ws.sent.find((m) => m.type === 'room-joined')?.host === false,
      c.ws.sent.find((m) => m.type === 'room-joined'));

    a.ws.drain();
    c.ws.drain();

    check('房间满员时 C 能进来（他确实知道口令）', (room._roomsIndex().get(ROOM_A) || new Set()).size === 2);

    await send(room, a.ws, { type: 'kick', room: ROOM_A, peerId: cId });
    check('A 能把 C 请出去', c.ws.sent.some((m) => m.type === 'kicked'), types(c.ws.sent));
    check('请出后位子空出来', (room._roomsIndex().get(ROOM_A) || new Set()).size === 1);
    check('请出后通知了操作方之外的人（C 走了不算 A 自己）', !a.ws.sent.some((m) => m.type === 'kicked'));

    // 这正是房间限 2 人在这个场景下的意义：位子空出来，真正的对端才能进
    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });
    check('真正的对端随后能进来', b.ws.sent.some((m) => m.type === 'room-joined'), types(b.ws.sent));
    check('A 收到新对端', a.ws.sent.some((m) => m.type === 'peer-joined'));

    // ---- 关键新规则：权限只归房主 ----
    const aIdNow = a.ws.deserializeAttachment().peerId;
    a.ws.drain();
    await send(room, b.ws, { type: 'kick', room: ROOM_A, peerId: aIdNow });
    check('非房主（后进者）不能把房主请出去', !a.ws.sent.some((m) => m.type === 'kicked'), types(a.ws.sent));
    check('房主在非房主的踢人请求下安然无恙', (room._roomsIndex().get(ROOM_A) || new Set()).has(a.ws));

    // ---- 安全边界 ----
    const bId = b.ws.deserializeAttachment().peerId;
    b.ws.drain();
    await send(room, b.ws, { type: 'kick', room: ROOM_A, peerId: bId });
    check('不能踢自己', !b.ws.sent.some((m) => m.type === 'kicked'));
    check('踢自己后仍在房间里', (room._roomsIndex().get(ROOM_A) || new Set()).has(b.ws));

    const outsider = await open(room);
    await send(room, outsider.ws, { type: 'join', room: ROOM_B, clientId: 'cz' });
    b.ws.drain();
    await send(room, outsider.ws, { type: 'kick', room: ROOM_A, peerId: bId });
    check('不在这个房间的人无权踢人', !b.ws.sent.some((m) => m.type === 'kicked'));
    check('B 安然无恙', (room._roomsIndex().get(ROOM_A) || new Set()).has(b.ws));

    a.ws.drain();
    await send(room, b.ws, { type: 'kick', room: ROOM_A, peerId: 'no-such-peer' });
    check('踢一个不存在的 peerId 没有副作用', a.ws.sent.length === 0);
  }

  /* ---------------------------- 12. 房主接任与认领 ---------------------------- */
  section('12. 房主离开 / 断线重连时的身份归属');
  {
    // (a) 房主真的走了 → 房里剩下的老人接任，否则这间房再没人能请人
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });
    check('A 是房主', a.ws.sent.find((m) => m.type === 'room-joined')?.host === true);
    check('B 不是房主', b.ws.sent.find((m) => m.type === 'room-joined')?.host === false);

    a.ws.drain();
    b.ws.drain();
    await send(room, a.ws, { type: 'leave', room: ROOM_A });   // 房主离开

    const c = await open(room);
    await send(room, c.ws, { type: 'join', room: ROOM_A, clientId: 'cc' });
    check('房主走后，房里剩下的 B 接任（收到 host=true）',
      b.ws.sent.some((m) => m.type === 'host' && m.host === true), types(b.ws.sent));
    check('新人 C 依然不是房主',
      c.ws.sent.find((m) => m.type === 'room-joined')?.host === false);

    const cId = c.ws.deserializeAttachment().peerId;
    c.ws.drain();
    await send(room, b.ws, { type: 'kick', room: ROOM_A, peerId: cId });
    check('接任后的 B 确实能行使房主权限', c.ws.sent.some((m) => m.type === 'kicked'));
  }
  {
    // (b) 房主断线重连（clientId 不变）→ 认得回房主身份，一次网络抖动不会永久丢权限
    const ctx = new FakeCtx();
    const room = new SignalRoom(ctx, {});
    room.ctx = ctx;

    const a = await open(room);
    await send(room, a.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });
    const b = await open(room);
    await send(room, b.ws, { type: 'join', room: ROOM_A, clientId: 'cb' });

    a.ws.readyState = 3;
    await room.webSocketClose(a.ws);                           // 房主掉线
    const a2 = await open(room);
    await send(room, a2.ws, { type: 'join', room: ROOM_A, clientId: 'ca' });   // 带着同一 clientId 回来

    check('房主断线重连后仍是房主',
      a2.ws.sent.find((m) => m.type === 'room-joined')?.host === true,
      a2.ws.sent.find((m) => m.type === 'room-joined'));

    const bId = b.ws.deserializeAttachment().peerId;
    b.ws.drain();
    await send(room, a2.ws, { type: 'kick', room: ROOM_A, peerId: bId });
    check('重连回来的房主能请走对方', b.ws.sent.some((m) => m.type === 'kicked'));
  }

  /* ---------------------------- 结果 ---------------------------- */
  console.log('\n' + '─'.repeat(52));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('─'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试自身出错：', e);
  process.exit(2);
});
