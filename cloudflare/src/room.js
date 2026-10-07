'use strict';
/**
 * RoomTalk 信令 Durable Object
 * ===========================================================================
 * 职责极其单一：**当介绍人**。
 *
 * 两端凭同一个口令进入同一间房之后，这个 DO 只做一件事 —— 把双方的
 * SDP / ICE 候选互相递一次。递完就没它什么事了：
 *   · 文字走 WebRTC DataChannel       → 端到端直连
 *   · 语音 / 视频走 SRTP              → 端到端直连
 * 它看不到、也存不下任何通话内容。全程**不使用 storage**，没有任何落库动作。
 *
 * ---------------------------------------------------------------------------
 * 架构：一个 DO 实例（name='global'）承载整张房间表
 *
 * 直觉会选「一间房一个 DO」，但那样每加一间房就多一个实例，而单实例 DO 的
 * 请求吞吐软上限约 1,000 次/秒，房间表放内存里反而最省。真到瓶颈再按房间号
 * 哈希分片，协议不用动。
 *
 * ---------------------------------------------------------------------------
 * 三条必须守住的实现约束（都是踩出来的）：
 *
 * ① 用 Hibernation API（ctx.acceptWebSocket），不能用普通 accept()。
 *    普通 accept 会让 DO 在整条连接存活期间持续计 duration —— 单个 128MB
 *    实例常驻一天就是 10,800 GB-s，而免费额度只有 13,000 GB-s/天。
 *    代价：内存状态休眠后丢失 → 房间表必须能**懒重建**（见 _roomsIndex）。
 *
 * ② 保活消息交给运行时自动回复（setWebSocketAutoResponse）。
 *    ⚠ 匹配是**逐字精确**的字符串比较，PING_MSG 必须与前端
 *      `JSON.stringify({type:'ping'})` 的结果完全一致。差一个空格就静默失效：
 *      不报错、功能正常，只是开始按满额计费。
 *
 * ③ 绝不能加 setInterval 心跳 —— 那会不停唤醒 DO，把休眠优化彻底抵消。
 *    连接存活性交给 Cloudflare，客户端靠 onclose 自动重连。
 */

/* ============================== 常量 ============================== */

/**
 * 打洞用的 STUN 服务器。顺序有意义：ICE 按顺序尝试，可达的要放前面。
 *
 * Cloudflare 的 STUN 免费且不限量（不计入任何计费额度），放第一；
 * miwifi 是国内兜底；Google 那两个在国内不通，放最后免得拖慢候选收集。
 */
export const BASE_ICE = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * 房间 ID 校验。
 *
 * 前端传来的是 SHA-256(口令) 派生的十六进制串 —— 服务端**永远看不到口令原文**，
 * 只看到一个随机串。即便这台服务器被翻，也推不出你们约定的暗号。
 * 长度放宽到 16~64 是为了给将来换哈希截断长度留余地。
 */
const ROOM_ID_RE = /^[0-9a-f]{16,64}$/;

/**
 * 房间人数上限 = 2。
 *
 * 这是产品语义，不是可调参数：约定的口令天然就是「两个人」的场景。
 * 它同时还是成本闸门 —— 房间人数直接等于每次广播的扇出，
 * 也是「口令被人猜中/转发出去」时唯一挡得住第三个人的东西。
 */
const ROOM_LIMIT = 2;

/**
 * 单连接最多同时待几间房。
 *
 * 这里只需要 1 间（不像 flashdrop 要同时待在自动发现房 / 公共房 / 配对房），
 * 但重连切换房间的瞬间可能短暂重叠，留 4 的余量就够。
 * 上限不能大：DO 的 serializeAttachment 上限是 **16,384 字节**，超限直接抛错，
 * 而写入外面通常套了 try/catch，于是会「静默失败」—— rooms 记录凭空消失、
 * 表现为「明明同房却互相看不见」，比直接拒绝难查得多。
 */
const MAX_ROOMS_PER_CONN = 4;

/** 全局连接数上限。默认值可用 env.MAX_CONNECTIONS 覆盖。 */
const MAX_CONNECTIONS = 2000;

/** 全局房间数上限。挡的是「新建房间」，已在册的房间仍可进入。 */
const MAX_ROOMS_TOTAL = 5000;

/**
 * 单连接消息限流（固定 1 秒窗口）。
 *
 * 阈值可以设得比 flashdrop 小得多：语音/视频走 P2P，**不经过这条 WS**，
 * 这里只跑 SDP 和 ICE 候选（加起来几十条）。200 条/秒对正常协商绰绰有余，
 * 但足以封住「用一条连接把 DO 的 CPU 打满」这种滥用。
 */
const MSG_MAX_PER_SEC = 200;
const MSG_MAX_BYTES_PER_SEC = 8 * 1024 * 1024;

/** 保活消息的字面量 —— 见文件头 ②，改动前务必确认前端同步。 */
const PING_MSG = '{"type":"ping"}';
const PONG_MSG = '{"type":"pong"}';

const MAX_NAME_LEN = 24;

/* ============================== Durable Object ============================== */

export class SignalRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this._rooms = null;      // Map<roomId, Set<WebSocket>>，休眠后重建
    this._rate = new Map();  // WebSocket → {t,n,bytes}，限流窗口

    this._setupAutoResponse();
  }

  /**
   * 把保活请求交给运行时自动回复（见文件头 ②）。
   * 放在构造函数里：DO 每次从休眠唤醒都会重跑构造函数，配置自动重新生效。
   */
  _setupAutoResponse() {
    try {
      if (typeof WebSocketRequestResponsePair !== 'function') return;
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MSG, PONG_MSG));
    } catch { /* 本地 shim 没有这个 API，忽略 */ }
  }

  get maxConnections() {
    const n = Number(this.env && this.env.MAX_CONNECTIONS);
    return Number.isFinite(n) && n > 0 ? n : MAX_CONNECTIONS;
  }

  get maxRoomsTotal() {
    const n = Number(this.env && this.env.MAX_ROOMS_TOTAL);
    return Number.isFinite(n) && n > 0 ? n : MAX_ROOMS_TOTAL;
  }

  /** 抽成方法是为了能被测试直接验证（fetch 里那几行依赖 WebSocketPair，离线造不出来）。 */
  _connectionsFull() {
    return this.ctx.getWebSockets().length >= this.maxConnections;
  }

  /* --------------------------- 连接建立 --------------------------- */

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('RoomTalk signaling endpoint (WebSocket only)', {
        status: 426,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // 闸门放在最前面：拒绝比接收便宜得多。用 503 而不是静默断开，
    // 前端才能显示「服务器繁忙」而不是含糊的「连不上」。
    if (this._connectionsFull()) {
      return new Response('Server busy, please retry later', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // 休眠式 accept —— 与普通 accept 的区别全在这一行
    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({
      peerId: crypto.randomUUID(),
      clientId: '',     // 由 join 消息带入，用于识别「自己的旧连接」
      name: '',
      rooms: [],
      roomHost: {},     // { 房间号: 房主的身份键 } —— 见 _join 里的房主判定
      joinedAt: Date.now(),
    });

    this._send(server, {
      type: 'self',
      peerId: server.deserializeAttachment().peerId,
      iceServers: BASE_ICE,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /* --------------------------- 消息分发 --------------------------- */

  async webSocketMessage(ws, raw) {
    // 限流必须在 JSON.parse 之前 —— 解析本身也要花 CPU，垃圾消息不该走到那一步。
    // （被 auto-response 接走的保活消息根本不会进到这里，所以不占额度。）
    if (!this._allowMessage(ws, raw)) {
      this._send(ws, { type: 'error', reason: 'rate-limited' });
      try { ws.close(1008, 'rate limited'); } catch { /* 可能已经关闭 */ }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ping':
        // 客户端每 75 秒发一次保活（Cloudflare 的 WS 有 100 秒空闲超时）。
        // 正常情况下它会被 auto-response 在休眠状态下直接接走，走不到这里；
        // 保险起见回一个 pong。服务端仍然不主动心跳。
        this._send(ws, { type: 'pong' });
        break;

      case 'pong':
        break;

      case 'join':
        this._handleJoin(ws, msg);
        break;

      case 'leave':
        if (typeof msg.room === 'string') this._leave(ws, msg.room);
        break;

      case 'signal':
      case 'relay':
        this._relay(ws, msg);
        break;

      case 'kick':
        this._handleKick(ws, msg);
        break;

      case 'rename': {
        const name = String(msg.name || '').slice(0, MAX_NAME_LEN).trim();
        if (!name) break;
        const att = this._patch(ws, { name });
        for (const roomId of att.rooms || []) {
          for (const other of this._roomsIndex().get(roomId) || []) {
            if (other !== ws) {
              this._send(other, { type: 'peer-renamed', peerId: att.peerId, name });
            }
          }
        }
        break;
      }

      default:
        break;
    }
  }

  async webSocketClose(ws) {
    // 限流桶必须跟着连接回收，否则 Map 会随连接数一直长
    // （key 是 ws 对象，连接没了就再没人能取到它，纯泄漏）
    this._rate.delete(ws);
    const att = ws.deserializeAttachment() || {};
    for (const roomId of [...(att.rooms || [])]) this._leave(ws, roomId);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /* --------------------------- 入房 --------------------------- */

  _handleJoin(ws, msg) {
    const roomId = String(msg.room || '').trim().toLowerCase();
    if (!ROOM_ID_RE.test(roomId)) {
      this._send(ws, { type: 'room-error', code: 'bad-room', reason: '房间标识无效' });
      return;
    }

    const clientId = String(msg.clientId || '').slice(0, 64);
    const name = String(msg.name || '').slice(0, MAX_NAME_LEN).trim();
    this._patch(ws, { clientId, name });

    // 一个连接同时只待一间房：换房时先退出旧的，避免占用别的房间的名额
    const cur = ws.deserializeAttachment() || {};
    for (const old of [...(cur.rooms || [])]) {
      if (old !== roomId) this._leave(ws, old);
    }

    const r = this._join(ws, roomId);
    if (!r.ok) {
      this._send(ws, {
        type: 'room-error',
        code: r.reason,
        reason: r.reason === 'room-full'
          // 房间满 = 这个口令正被另一对人用着。把两条出路都说清楚：
          // 要么等对方结束腾出位子，要么换一个更独特的口令。
          // 绝不能含糊成「进不去」——那会被当成网络故障，用户只会反复重试。
          ? '这个口令已经被两个人占用了。要么等他们结束后再试，要么和对方换一个更独特的口令。'
          : '服务器繁忙，请稍后重试',
        count: r.count,
        limit: r.limit,
      });
      return;
    }
    this._send(ws, { type: 'room-joined', room: roomId, host: !!r.host });
  }

  /**
   * 加入房间。
   *
   * @returns {{ok:true}|{ok:false, reason:'room-full'|'server-full'|'room-limit', count?:number, limit?:number}}
   *   调用方**必须**把这个结果报给客户端 —— 静默失败是最难查的一类 bug。
   */
  _join(ws, roomId) {
    const rooms = this._roomsIndex();

    // 已在房里：先退出，保证对端不会收到「先 joined 后 left」的乱序
    const before = ws.deserializeAttachment() || {};
    if ((before.rooms || []).includes(roomId)) this._leave(ws, roomId);

    // 封顶必须在 leave 之后判断，否则「重复加入同一间房」会被自己误判成超限。
    // 这里要重新 deserialize：before 是 leave 之前的快照，还留着刚退掉的那个 ID。
    const cur = ws.deserializeAttachment() || {};
    if ((cur.rooms || []).length >= MAX_ROOMS_PER_CONN) {
      return { ok: false, reason: 'room-limit' };
    }

    let room = this._ensureRoom(rooms, roomId);
    if (!room) return { ok: false, reason: 'server-full' };

    const myClientId = cur.clientId;

    if (room.size >= ROOM_LIMIT) {
      // 先剔僵尸再下结论。少了这一步，「刷新页面」就会把自己挡在门外：
      // 旧连接尚未回收，新连接的加入请求已经到了，于是 2/2 的房间把真正的
      // 第二台设备拒掉。
      //
      // 除了已关闭的连接，还要踢掉「clientId 与自己相同」的旧连接 ——
      // 断网重连时旧连接可能还挂着（TCP 假死，readyState 仍是 1），
      // 它占的是你自己的名额。同一 clientId 只可能来自你自己的另一个标签页
      // 或自己上一次连接，踢掉是安全的。
      for (const other of [...room]) {
        if (other.readyState !== 1) { this._leave(other, roomId); continue; }
        const oa = other.deserializeAttachment() || {};
        if (myClientId && oa.clientId && oa.clientId === myClientId) {
          this._leave(other, roomId);
          try { other.close(4001, 'replaced by newer connection'); } catch { /* noop */ }
        }
      }
      // _leave 可能把空房间整条回收 —— 必须重新取，否则后面往里加的是孤儿集合
      room = this._ensureRoom(rooms, roomId);
      if (!room) return { ok: false, reason: 'server-full' };
      if (room.size >= ROOM_LIMIT) {
        return { ok: false, reason: 'room-full', count: room.size, limit: ROOM_LIMIT };
      }
    }

    const existing = [];
    for (const other of room) existing.push(this._info(other));

    /* ------------------------------ 房主判定 ------------------------------
     * 房主 = **第一个进入这间房的人**，只有他有「把对方请出去」的权限
     * （见 _handleKick）。房主身份记在**每个成员**的 attachment 上
     * （roomHost[房间号] = 房主的身份键），谁都能读到「这间房的房主是谁」——
     * 于是不需要在内存里另维护一张房主表，休眠重建后也不会丢。
     *
     * 身份键用 clientId（见 _keyOf），它只用来认出「还是同一条连接」，
     * **不用来做权限继承**。
     *
     * ⚠ 房主会换人，规则是「**谁先退出谁让位**」，落地在 _leave / _ensureHost：
     *   · 房里没人   → 我就是房主（第一个到的）
     *   · 房主还在   → 沿用，后进者没有权限
     *   · 房主已不在 → 由房里剩下的人接任。正常不会走到这里（_leave 已经即时
     *                  换好了），这里只是兜底：比如休眠重建后状态不一致。
     */
    const myKey = this._keyOf(cur);
    const hostKey = existing.length ? this._ensureHost(roomId, room) : myKey;
    const iAmHost = hostKey === myKey;

    // 顺序：先通知房内已有的人，再把「已有的人」回给新来的。
    // 两端 WS 是并行的，老设备收到 peer-joined 后会立刻发 offer，
    // 可能比 peers 先到新设备 —— 新设备此时还不知道这个 peerId，
    // 需要靠前端的「未知发送者消息缓存」兜住（见 app.js）。
    for (const other of room) {
      this._send(other, { type: 'peer-joined', room: roomId, peer: this._info(ws) });
    }

    room.add(ws);
    const nextHosts = Object.assign({}, cur.roomHost || {});
    nextHosts[roomId] = hostKey;
    this._patch(ws, { rooms: (cur.rooms || []).concat(roomId), roomHost: nextHosts });

    this._send(ws, { type: 'peers', room: roomId, peers: existing });
    return { ok: true, host: iAmHost };
  }

  _leave(ws, roomId) {
    const a = ws.deserializeAttachment() || {};
    if (!(a.rooms || []).includes(roomId)) return;   // 本来就不在这间房，别广播

    // roomHost 必须跟着 rooms 一起删。它俩是一对：只在「还在这间房里」时才有意义，
    // 留着已退出房间的那条记录，只会让 attachment 随「换过多少间房」一路变大
    // （同一条长连接反复换房是正常用法），最后还会撞上 attachment 的体积上限、
    // 被 _patch 静默吞掉 —— 那连还留着的房间也会跟着丢房主记录。
    const hosts = Object.assign({}, a.roomHost || {});
    delete hosts[roomId];
    this._patch(ws, { rooms: a.rooms.filter((r) => r !== roomId), roomHost: hosts });

    const rooms = this._roomsIndex();
    const room = rooms.get(roomId);
    if (!room) return;

    room.delete(ws);
    const others = [...room];
    // 只有**两个人都走了**，房间（也就是这个口令的占用）才真正腾出来。
    // 房里还有人时房间一直开着 —— 这正是「A 退出后 B 还在，房间不关闭」的由来。
    if (room.size === 0) rooms.delete(roomId);

    for (const other of others) {
      this._send(other, { type: 'peer-left', room: roomId, peerId: a.peerId });
    }

    // 走掉的如果是房主 → 房里剩下的人**立刻**接任房主（房间继续开着，只是
    // 「说了算的人」换了一个）。刻意放在这里而不是等下一个新人进来：
    // 房主退出的那一刻，B 就该拿到权限，而不是「等有人进来才补发」。
    // 由此推出的产品规则 —— 原房主再进来时是**后进者**，不再有请人出去的权限。
    if (others.length) this._ensureHost(roomId, room);
  }

  /* --------------------------- 房间表 --------------------------- */

  /**
   * 懒重建房间表。
   *
   * 休眠会让内存清空，但每条活着的 WebSocket 上还挂着 attachment，
   * 里面记着它加入过哪些房间 —— 拿这个当唯一真相重建即可。
   * 不额外持久化房间表，也就不会有 storage 读写（既省钱，也不会唤醒 DO）。
   */
  _roomsIndex() {
    if (this._rooms) return this._rooms;
    const m = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      for (const roomId of a.rooms || []) {
        if (!m.has(roomId)) m.set(roomId, new Set());
        m.get(roomId).add(ws);
      }
    }
    this._rooms = m;
    return m;
  }

  /** 取房间，不存在就现建 —— 但受全局房间数闸门约束。 */
  _ensureRoom(rooms, roomId) {
    let room = rooms.get(roomId);
    if (room) return room;
    if (rooms.size >= this.maxRoomsTotal) return null;
    room = new Set();
    rooms.set(roomId, room);
    return room;
  }

  _patch(ws, patch) {
    const a = ws.deserializeAttachment() || {};
    const next = Object.assign({}, a, patch);
    try { ws.serializeAttachment(next); } catch { /* 连接可能已关闭，超限也可能抛 */ }
    return next;
  }

  /**
   * 一条连接的「身份键」——用于判定它是不是房主。
   *
   * 用 **clientId**（前端 sessionStorage 里那个随机串）：同一个标签页断线重连
   * 时它不变，所以房主掉线再回来能认领回自己的身份。没有 clientId 时才退回
   * peerId（那种情况下重连会被当成新设备，属于可接受的降级）。
   */
  _keyOf(a) {
    return (a && (a.clientId || a.peerId)) || '';
  }

  /** 把「这间房的房主是谁」写到某条连接的 attachment 上（合并，不覆盖别的房间）。 */
  _setRoomHost(ws, roomId, key) {
    const a = ws.deserializeAttachment() || {};
    const rh = Object.assign({}, a.roomHost || {});
    rh[roomId] = key;
    this._patch(ws, { roomHost: rh });
    return rh;
  }

  /**
   * 确保房间里有一位**在座**的房主，返回房主的身份键。
   *
   * 房主不在房里了（主动退出 / 断线 / 从没记录过）→ 把房主身份立刻转给房里
   * 剩下的人，并单独通知他一声（客户端据此亮出「请出房间」按钮）。
   * 房间上限是 2，所以「剩下的人」最多一个，取第一个即可。
   *
   * ⚠ 刻意**不**做「原房主回来就把身份还给他」：产品规则是「谁先退出谁让位」。
   *   A 先退出 → B 自动接任房主 → A 再进来就是后进者，没有请人权。
   *   简单、确定，不会出现两个人争房主。代价是刷新页面也会让位 —— 但这条
   *   规则本身对用户是好解释的，而「争房主」是没法解释的。
   */
  _ensureHost(roomId, room) {
    let hostKey = '';
    for (const other of room) {
      const h = (other.deserializeAttachment() || {}).roomHost;
      if (h && h[roomId]) { hostKey = h[roomId]; break; }
    }
    // 房主还在座 → 什么都不用做
    if (hostKey && [...room].some((w) => this._keyOf(w.deserializeAttachment() || {}) === hostKey)) {
      return hostKey;
    }

    const heir = room.values().next().value;
    if (!heir) return '';
    hostKey = this._keyOf(heir.deserializeAttachment() || {});
    this._setRoomHost(heir, roomId, hostKey);
    this._send(heir, { type: 'host', room: roomId, host: true });
    return hostKey;
  }

  /**
   * 每连接的固定窗口限流（1 秒）。
   * 用内存 Map 而不是 attachment：写得省，且限流状态本来就允许丢
   * —— DO 既然会休眠，说明根本没什么消息。
   */
  _allowMessage(ws, raw) {
    const bytes = typeof raw === 'string' ? raw.length : ((raw && raw.byteLength) || 0);
    const now = Date.now();
    let b = this._rate.get(ws);
    if (!b || now - b.t >= 1000) {
      b = { t: now, n: 0, bytes: 0 };
      this._rate.set(ws, b);
    }
    b.n++;
    b.bytes += bytes;
    return b.n <= MSG_MAX_PER_SEC && b.bytes <= MSG_MAX_BYTES_PER_SEC;
  }

  /* --------------------------- 请出房间 --------------------------- */

  /**
   * 把同房间的另一个人移出房间。
   *
   * 为什么服务端必须支持这个：口令是**共享秘密** —— 它只证明「知道这串字」，
   * 不证明「你是这个人」。任何拿到口令的人都进得来。而房间上限是 2，
   * 一旦被陌生人占了位子，真正的对方就永远进不来（会收到 room-full）。
   * 所以「把对方请出去」这道口子必须留着。
   *
   * 但权限只给**房主**（第一个进入这间房的人，见 _join 里的房主判定）：
   * 后进来的一方没有这个能力。这样「谁先开的口令、谁说了算」是确定的，
   * 不会出现两个人都能互相请走、来回拉锯。
   *
   * 边界收得很紧：只能踢**自己所在房间里的其他人** ——
   * 不能踢自己、不能跨房间踢、不是房主的人发这条消息会被直接忽略。
   */
  _handleKick(ws, msg) {
    const room = msg.room ? this._roomsIndex().get(msg.room) : null;
    if (!room) return;
    if (!room.has(ws)) return;                 // 自己都不在这间房，无权操作

    const me = ws.deserializeAttachment() || {};
    if (!msg.peerId || msg.peerId === me.peerId) return;   // 不能踢自己

    // 只有房主能请人出去 —— 这里必须服务端校验，前端藏按钮不算数
    const host = (me.roomHost || {})[msg.room];
    if (!host || host !== this._keyOf(me)) return;

    for (const other of [...room]) {
      const oa = other.deserializeAttachment() || {};
      if (oa.peerId !== msg.peerId) continue;

      this._leave(other, msg.room);
      // 告诉被踢的人原因，别让他以为是网络故障
      this._send(other, { type: 'kicked', room: msg.room });
      return;
    }
  }

  /* --------------------------- 转发 --------------------------- */

  /**
   * 只在发送者所在的同一个房间里转发。
   *
   * ⚠ 必须校验 `room.has(senderWs)`：只判断「房间存在 + 目标在房间里」是不够的。
   * 房间标识虽然不可猜（哈希派生），但一个**已经退出房间**的连接若能继续投递
   * SDP/ICE，就能把自己重新插回一场正在进行的通话里。这一行是必须的。
   */
  _relay(senderWs, msg) {
    const room = msg.room ? this._roomsIndex().get(msg.room) : null;
    if (!room) return;
    if (!room.has(senderWs)) return;

    const sa = senderWs.deserializeAttachment() || {};

    let target = null;
    for (const ws of room) {
      const a = ws.deserializeAttachment();
      if (a && a.peerId === msg.to && a.peerId !== sa.peerId) { target = ws; break; }
    }
    if (!target) return;

    this._send(target, {
      type: msg.type === 'relay' ? 'relay-in' : 'sig',
      senderId: sa.peerId,
      payload: msg.payload,
    });
  }

  /** 只暴露对方需要的字段。**不返回 IP** —— 这个产品的卖点就是不留痕迹。 */
  _info(ws) {
    const a = ws.deserializeAttachment() || {};
    return { id: a.peerId, name: a.name || '' };
  }

  _send(ws, message) {
    if (!ws) return;
    try { ws.send(JSON.stringify(message)); } catch { /* 连接正在关闭，忽略 */ }
  }
}
