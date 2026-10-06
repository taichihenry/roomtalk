'use strict';
/* ===========================================================================
   RoomTalk · 客户端
   ===========================================================================
   三件事，按重要性排：

   ① 口令 → 房间号，在**本地**完成（PBKDF2）。服务器只拿到一个 32 位十六进制
      串，既不知道口令是什么，也无从反推。这是这个产品「谁也别想查」的地基。

   ② 信令只是介绍人。两端交换一次 SDP / ICE 之后就退场，
      文字走 DataChannel、语音视频走 SRTP，全部端到端直连。

   ③ 用 Perfect Negotiation 处理重新协商。因为「什么时候开麦克风、什么时候开
      摄像头」是用户临时决定的 —— 两端随时可能同时想改，必须有一套确定的
      冲突消解规则，否则会卡在 glare 死锁里。
   =========================================================================== */

(() => {

/* ============================== 工具 ============================== */

const $ = (id) => document.getElementById(id);

/*
 * 保活间隔。必须 < Cloudflare 的 100 秒空闲超时。
 *
 * 为什么是 25 秒而不是贴着 100 秒来：这条 ping 会被服务端的
 * setWebSocketAutoResponse 在**休眠状态下直接接走**，不唤醒 Durable Object、
 * 不产生时长计费（入站消息也按 20:1 折算请求）。所以频率放高一点几乎不要钱，
 * 却换来一个关键能力 —— 见下面的 PONG_TIMEOUT。
 */
const PING_INTERVAL = 25_000;

/*
 * 保活回音超时。
 *
 * 这是本客户端最重要的一道自愈机制：**浏览器不一定知道自己的连接已经死了**。
 * 实测（workerd）优雅关闭要等对端回关闭帧，onclose 可能十秒后才来；
 * 而真实世界的「网线被拔 / 切基站」会让 TCP 静默挂起，onclose 要等 TCP 重传
 * 超时，几十秒都正常。
 *
 * 所以不能只靠 onclose：每次 ping 发出去后若这么久还没收到 pong，
 * 就主动判定这条连接已死、立即进入重连。
 */
const PONG_TIMEOUT = 8_000;

const PEER_LEFT_GRACE = 1_500;  // 对方断开后等这么久再宣布，避开「重连抖动」
const PENDING_TTL = 15_000;     // 未知发送者的信令缓存时长

/*
 * 两道内存闸门。
 *
 * 这个页面会被开着放很久（通话动辄一小时），所以任何「只增不减」的结构
 * 都是隐患 —— 短时间看不出问题，开久了才会卡。
 *   · pending：正常协商最多堆几条，但对端持续灌消息时不能无限涨
 *   · 消息 DOM：没人会往上翻几百条，多留只是白占内存、拖慢渲染
 */
const MAX_PENDING = 200;
const MAX_MESSAGES = 800;

/*
 * 画质档位 —— 用户自己选，通话中随时可换。
 *
 * 每一档同时管两件事，缺一个都会「不流畅」：
 *   · maxBitrate            —— 上限，防上行被打满。
 *                              **卡顿的真实根因是上行拥塞，不是画质不够。**
 *   · scaleResolutionDownBy —— 编码前缩放（从 720p 采集往下压）。
 *
 * ⚠ scaleResolutionDownBy 是整件事的关键：它改的是**编码器输入**，
 *   不需要重新协商 SDP、也不会重启摄像头，所以切档是**瞬时**的。
 *   如果改成重新 getUserMedia，每次切档画面都会黑一下 —— 那才叫不流畅。
 *
 * 这是**你发出的**画质的档位：省的是你自己手机的流量，
 * 对方看到的画面跟着变。反过来不成立 —— 调高不会让对方发得更清晰。
 */
const QUALITY_TIERS = {
  saver:  { label: '省流量', maxBitrate: 300_000,   scale: 2,    mbPerHour: 270 },
  smooth: { label: '流畅',   maxBitrate: 600_000,   scale: 1.35, mbPerHour: 540 },
  sharp:  { label: '清晰',   maxBitrate: 1_200_000, scale: 1,    mbPerHour: 1080 },
};
const QUALITY_DEFAULT = 'smooth';
const QUALITY_KEY = 'rt.quality';

/** 口令 → 房间号。加盐 + 迭代，抬高弱口令被离线枚举的成本。 */
async function deriveRoomId(passphrase) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('roomtalk/v1'), iterations: 100_000, hash: 'SHA-256' },
    key, 128,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 每个标签页一个稳定 ID，用于服务端识别「自己的旧连接」（断网重连时靠它踢掉僵尸）。 */
function clientId() {
  let v = sessionStorage.getItem('rt.cid');
  if (!v) { v = crypto.randomUUID(); sessionStorage.setItem('rt.cid', v); }
  return v;
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return '未知设备';
}

/* ============================== 身份 ============================== */

/**
 * 这台设备的持久标识，随浏览器保留。
 *
 * 它是一张「名片」，用来让固定联系人认出你 —— 见下面的信任机制。
 * 注意它**不是密码学身份**：不像密钥那样能证明「我就是我」，
 * 只是一个难以猜中的随机串。这是共享口令方案能做到的上限。
 */
function deviceId() {
  let v = localStorage.getItem('rt.did');
  if (!v) { v = crypto.randomUUID(); localStorage.setItem('rt.did', v); }
  return v;
}

/*
 * 身份记忆（TOFU：Trust On First Use）
 * ---------------------------------------------------------------------------
 * 这解决的是纯口令方案唯一的硬伤：**口令只证明「知道这串字」，不证明
 * 「你是这个人」**。如果 A/B 和 C/D 碰巧约定了同一串口令，A 光看口令
 * 没有任何办法分辨进来的是 B 还是 C —— 这不是实现缺陷，是信息论层面的
 * 必然：两个人的知识完全相同时，无法区分。
 *
 * 绕开的办法是给每个人一张名片：第一次连接时把对方的设备标识记下来，
 * 以后再连就比对。对不上就明确告诉用户，并让他一键请出去。
 *
 * ⚠ 必须如实告知用户这是 TOFU 而非认证：**第一次**连接时无法验证对方是谁，
 *   所以它防得住「后来混进来的人」，防不住「第一次就是他」。界面上不能
 *   给用户虚假的安全感。
 *
 * 信任和拉黑都按房间号隔离 —— 换一个口令就是另一段关系，互不影响。
 */
function trustKey(room) { return 'rt.trust.' + room; }
function blockKey(room) { return 'rt.block.' + room; }

function getTrusted(room) { return localStorage.getItem(trustKey(room)); }
function setTrusted(room, id) { localStorage.setItem(trustKey(room), id); }

function getBlocked(room) {
  try {
    const v = JSON.parse(localStorage.getItem(blockKey(room)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function addBlocked(room, id) {
  if (!id) return;
  const list = getBlocked(room);
  if (!list.includes(id)) {
    list.push(id);
    // 只留最近 20 个，避免 localStorage 无限增长
    localStorage.setItem(blockKey(room), JSON.stringify(list.slice(-20)));
  }
}

/* ============================== 状态 ============================== */

const S = {
  room: '',            // 房间号（口令的 PBKDF2 派生值）
  ws: null,
  peerId: null,
  iceServers: [],
  pingTimer: null,
  pongTimer: null,

  pc: null,
  dc: null,
  remotePeerId: null,
  peerDeviceId: null,   // 对端的设备标识，用来判断「是不是上次那个人」
  polite: true,        // Perfect Negotiation：true = 冲突时让步
  makingOffer: false,
  ignoreOffer: false,
  settingAnswer: false,

  localStream: null,   // 本地音视频源（跨 PC 重建复用）
  remoteStream: null,
  micTrack: null,
  camTrack: null,
  videoTuned: false,    // 视频发送端参数（码率上限 / 降级偏好）是否已生效
  quality: null,        // 画质档位（'saver' | 'smooth' | 'sharp'）
  remoteQuality: null,  // 对端选的档位（只用来提示，不影响我这边）
  media: { audio: false, video: false },        // 本端开关状态
  remoteMedia: { audio: false, video: false },  // 对端开关状态

  pending: [],         // 对端未确定时先收到的信令
  peerLeftTimer: null,
  kickedCount: 0,      // 累计被请出次数（排障与自动化测试用）
  retry: 0,
  retryTimer: null,
  leaving: false,
  started: false,
};

/* ============================== 状态显示 ============================== */

function setStatus(kind, text) {
  $('dot').className = 'dot' + (kind ? ' ' + kind : '');
  $('status').textContent = text;
}

function appendToLog(el) {
  const log = $('log');
  log.appendChild(el);
  // 长时间通话时限制 DOM 数量：没人会往上翻几百条，多留只是白占内存、拖慢渲染
  while (log.children.length > MAX_MESSAGES) log.removeChild(log.firstElementChild);
  scrollLog();
}

function notice(text) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = text;
  appendToLog(el);
}

function addMessage(text, who) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.textContent = text;          // textContent，天然免疫 XSS
  appendToLog(el);
}

/*
 * 滚动合并到下一帧再执行。
 * 直接写 scrollTop 会强制一次同步布局，连着来几条消息就是连着几次重排。
 */
let scrollQueued = false;
function scrollLog() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const log = $('log');
    log.scrollTop = log.scrollHeight;
  });
}

let toastTimer = null;
function toast(msg, ms = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ============================== 进房 ============================== */

async function onSubmitPassphrase(ev) {
  ev.preventDefault();
  const raw = $('passphrase').value.trim();
  const err = $('gate-error');

  if (!raw) { showError('请输入口令'); return; }
  if (!window.isSecureContext || !crypto.subtle) {
    showError('当前地址不是安全上下文，浏览器不支持加密与音视频。请用 https:// 打开。');
    return;
  }

  const btn = $('gate-submit');
  btn.disabled = true;
  btn.textContent = '正在派生…';

  try {
    const roomId = await deriveRoomId(raw);
    sessionStorage.setItem('rt.room', roomId);
    enterRoom(roomId);
  } catch (e) {
    console.error(e);
    showError('无法处理这个口令，请换一个试试');
  } finally {
    btn.disabled = false;
    btn.textContent = '进入';
  }
}

function showError(msg) {
  const err = $('gate-error');
  err.textContent = msg;
  err.hidden = !msg;
}

function enterRoom(roomId) {
  S.room = roomId;
  S.started = true;
  S.leaving = false;
  $('gate').hidden = true;
  $('room').hidden = false;
  $('log').innerHTML = '';
  setStatus('waiting', '正在连接…');
  connect();
  $('text').focus();
}

function backToGate() {
  S.leaving = true;
  S.started = false;
  clearTimeout(S.retryTimer);
  clearTimeout(S.peerLeftTimer);
  stopPing();
  try { S.ws && S.ws.close(1000, 'bye'); } catch { /* noop */ }
  S.ws = null;
  teardownPeer();
  stopLocalMedia();
  sessionStorage.removeItem('rt.room');
  $('room').hidden = true;
  $('stage').hidden = true;
  $('gate').hidden = false;
  $('passphrase').value = '';
  showError('');
  $('passphrase').focus();
}

/* ============================== 信令通道 ============================== */

function send(obj) {
  const ws = S.ws;
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(proto + '//' + location.host + '/ws');
  } catch (e) {
    setStatus('warn', '无法连接服务器');
    scheduleReconnect();
    return;
  }
  S.ws = ws;

  ws.onopen = () => {
    S.retry = 0;
    clearTimeout(S.pongTimer);
    setStatus('waiting', '正在加入房间…');
    send({ type: 'join', room: S.room, clientId: clientId(), name: guessDeviceName() });
  };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(m);
  };

  ws.onclose = () => {
    if (S.leaving || S.ws !== ws) return;
    handleSocketLost();
  };

  ws.onerror = () => { /* onclose 会跟上，不重复提示 */ };

  startPing();
}

/**
 * 判定「这条信令连接已经不能用」，进入重连。
 *
 * 两个触发源，缺一不可：
 *   ① ws.onclose —— 连接被明确关闭（正常、或浏览器/系统立刻报错）
 *   ② 保活回音超时 —— 连接假死（TCP 还挂着，但对面已经收不到了）
 * 只靠 ① 会让用户在弱网下干等几十秒。
 */
function handleSocketLost() {
  if (S.leaving) return;
  stopPing();

  const ws = S.ws;
  S.ws = null;   // 先摘掉，避免紧接着到来的 onclose 再走一遍
  try { ws && ws.close(); } catch { /* noop */ }

  setStatus('warn', '连接中断，正在重连…');
  $('btn-send').disabled = true;
  scheduleReconnect();
}

/** 发一次保活，并为它挂上回音超时。 */
function pingOnce() {
  if (!send({ type: 'ping' })) return;
  clearTimeout(S.pongTimer);
  S.pongTimer = setTimeout(handleSocketLost, PONG_TIMEOUT);
}

function startPing() {
  stopPing();
  // 只在页面前台可见时发：后台标签页的定时器会被浏览器节流，发也无意义。
  // 这个字面量必须与服务端 setWebSocketAutoResponse 注册的完全一致，
  // 差一个空格就静默失效（功能照常，但每条 ping 都变成唤醒 DO 并计费）。
  S.pingTimer = setInterval(() => {
    if (document.visibilityState === 'visible') pingOnce();
  }, PING_INTERVAL);
}

function stopPing() {
  if (S.pingTimer) { clearInterval(S.pingTimer); S.pingTimer = null; }
  if (S.pongTimer) { clearTimeout(S.pongTimer); S.pongTimer = null; }
}

function scheduleReconnect() {
  clearTimeout(S.retryTimer);
  const delay = Math.min(800 * Math.pow(1.7, S.retry), 15_000);
  S.retry++;
  S.retryTimer = setTimeout(() => {
    if (S.leaving) return;
    // 重连是一次全新的会面：旧的 peerId 已作废，对端也必须重建连接
    teardownPeer();
    S.remotePeerId = null;
    S.pending = [];
    connect();
  }, delay);
}

/* ============================== 服务端消息 ============================== */

function handleServerMessage(m) {
  switch (m.type) {
    case 'pong':
      // 保活回音：连接确实还活着，撤掉超时
      clearTimeout(S.pongTimer);
      break;

    case 'self':
      S.peerId = m.peerId;
      S.iceServers = Array.isArray(m.iceServers) ? m.iceServers : [];
      break;

    case 'room-joined':
      setStatus('waiting', '等待对方接入');
      break;

    case 'room-error':
      // 房间满了 / 服务器繁忙：都不该自动重试，直接把话说清楚并退回入口
      failToGate(m.reason || '无法进入这个房间');
      break;

    case 'peers':
      // 房里已经有人 → 他是主叫方，我应答
      if (Array.isArray(m.peers) && m.peers.length) {
        setStatus('waiting', '已找到对方，正在建立连接…');
        preparePeer(m.peers[0].id, false);
      }
      break;

    case 'peer-joined':
      // 有人进来了 → 我主叫
      clearTimeout(S.peerLeftTimer);
      setStatus('waiting', '已找到对方，正在建立连接…');
      preparePeer(m.peer.id, true);
      break;

    case 'peer-left':
      if (m.peerId === S.remotePeerId) handlePeerLeft();
      break;

    case 'kicked':
      // 被房间里的人请出去了。说清楚原因，别让用户以为是网络故障。
      S.kickedCount++;
      teardownPeer();
      S.remotePeerId = null;
      failToGate('对方把你请出了这个房间');
      break;

    case 'sig':
      onIncomingSignal(m.senderId, m.payload);
      break;

    case 'peer-renamed':
      break;

    default:
      break;
  }
}

/**
 * 进不去房间时退回入口，并把原因留在入口页上。
 *
 * 不留成一句 3 秒就消失的浮层：这类失败（口令被占用 / 被请出）需要用户
 * 看明白之后**做一个决定**，而不是被通知一下就没了。
 */
function failToGate(reason) {
  backToGate();
  showError(reason);
}

function handlePeerLeft() {
  // 等一小会儿再宣布 —— 对端可能只是断线重连，马上就会带新身份回来
  clearTimeout(S.peerLeftTimer);
  S.peerLeftTimer = setTimeout(() => {
    teardownPeer();
    S.remotePeerId = null;
    notice('对方已离开');
    setStatus('waiting', '等待对方接入');
  }, PEER_LEFT_GRACE);
}

/* ============================== WebRTC ============================== */

function teardownPeer() {
  if (S.dc) {
    S.dc.onopen = S.dc.onclose = S.dc.onmessage = null;
    try { S.dc.close(); } catch { /* noop */ }
    S.dc = null;
  }
  if (S.pc) {
    S.pc.onnegotiationneeded = S.pc.onicecandidate = null;
    S.pc.ontrack = S.pc.ondatachannel = S.pc.onconnectionstatechange = null;
    try { S.pc.close(); } catch { /* noop */ }
    S.pc = null;
  }
  S.remoteStream = null;
  S.peerDeviceId = null;
  S.ignoreOffer = false;
  S.makingOffer = false;
  S.settingAnswer = false;
  showTrust('', '');
  const rv = $('remote-video');
  if (rv.srcObject) rv.srcObject = null;
  $('btn-send').disabled = true;
  syncStage();
}

/**
 * 建立与某个对端的连接。
 * @param {string} peerId
 * @param {boolean} amCaller 是否由我发起（我建 DataChannel 并出 offer）
 */
function preparePeer(peerId, amCaller) {
  if (S.remotePeerId === peerId && S.pc) return;   // 已经在连了，别重建
  S.remotePeerId = peerId;
  S.polite = !amCaller;
  teardownPeer();
  buildPeerConnection(amCaller);
  flushPendingSignals();
}

function buildPeerConnection(amCaller) {
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });
  S.pc = pc;
  S.remoteStream = new MediaStream();

  // 本端已经开的麦克风/摄像头要跟着接进新连接（重连时全靠这一步）
  if (S.localStream) {
    for (const track of S.localStream.getTracks()) pc.addTrack(track, S.localStream);
  }

  pc.onnegotiationneeded = async () => {
    if (!S.remotePeerId) return;
    try {
      S.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal({ description: pc.localDescription.toJSON() });
    } catch (e) {
      console.warn('协商失败', e);
    } finally {
      S.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ candidate: candidate.toJSON() });
  };

  pc.ontrack = (ev) => {
    const rv = $('remote-video');
    const [stream] = ev.streams;
    if (stream) {
      if (rv.srcObject !== stream) rv.srcObject = stream;
    } else {
      S.remoteStream.addTrack(ev.track);
      rv.srcObject = S.remoteStream;
    }
    rv.play().catch(() => { /* iOS 可能需要用户手势，静默忽略 */ });
    if (ev.track.kind === 'video') {
      ev.track.addEventListener('ended', () => { S.remoteHasVideo = false; syncStage(); });
    }
    syncStage();
  };

  pc.ondatachannel = ({ channel }) => bindDataChannel(channel);

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') {
      setStatus('online', '已连接');
      // 首次协商完成后再设一次：addTrack 之后立刻改，encodings 可能还没生成
      tuneVideoSender(pc);
    } else if (st === 'disconnected') {
      setStatus('warn', '连接不稳定…');
    } else if (st === 'failed') {
      setStatus('warn', '连接中断，正在重试…');
      try { pc.restartIce(); } catch { /* 交由 Perfect Negotiation 处理 */ }
    }
  };

  if (amCaller) {
    const dc = pc.createDataChannel('chat', { ordered: true });
    bindDataChannel(dc);
  }

  // 本端已经有摄像头时（重连场景）顺手把码率参数也接上
  tuneVideoSender(pc);
}

/**
 * 给视频发送端套用当前画质档位。
 *
 * `degradationPreference` 才是「会不会卡」的那一句：
 *   · 'maintain-framerate'  —— 带宽不够时**降分辨率、保帧数**，画面持续流动
 *   · 'maintain-resolution' —— 保清晰度、丢帧，动起来像幻灯片
 *   · 'balanced'（默认）     —— 两者轮着丢，容易两边都不舒服
 * 和码率上限配套用：上限管住「不把上行打满」，这一句管住「打不满时先牺牲谁」。
 *
 * 切档也走这里 —— 一次 setParameters 就生效，不重新协商、不重启摄像头。
 * 非致命：任何一步失败都只是回到浏览器默认行为，不影响通话建立。
 */
async function tuneVideoSender(pc) {
  if (!pc || pc !== S.pc) return;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!sender) { S.videoTuned = false; return; }
  const tier = QUALITY_TIERS[currentQuality()];
  try {
    const p = sender.getParameters();
    // 首次协商完成前 encodings 可能是空数组，此时改不了 —— 等 connected 回调再试
    if (!p.encodings || p.encodings.length === 0) return;
    p.encodings[0].maxBitrate = tier.maxBitrate;
    p.encodings[0].scaleResolutionDownBy = tier.scale;
    p.degradationPreference = 'maintain-framerate';
    await sender.setParameters(p);
    S.videoTuned = true;
  } catch (e) {
    console.warn('画质参数未生效（不影响通话）', e);
  }
}

/* ---------------------------- 画质档位 ---------------------------- */

/** 当前档位名。永远返回合法值 —— localStorage 被改坏也只会回落默认档 */
function currentQuality() {
  return QUALITY_TIERS[S.quality] ? S.quality : QUALITY_DEFAULT;
}

function loadQuality() {
  let v = null;
  try { v = localStorage.getItem(QUALITY_KEY); } catch { /* 隐私模式下不可用 */ }
  S.quality = QUALITY_TIERS[v] ? v : QUALITY_DEFAULT;
}

function saveQuality(v) {
  try { localStorage.setItem(QUALITY_KEY, v); } catch { /* noop */ }
}

function fmtMB(mb) {
  return mb >= 1000 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
}

/**
 * 切档。setParameters 是瞬时的 —— 不断流、不重新协商、画面不黑。
 *
 * 每次切换都要把话讲明白：「省流量」很容易被理解成
 * 「省对方的流量」或者「让对方发得更清晰」，其实都不是 ——
 * 它只决定**我发出去的**画面。
 */
async function onQualityChange(ev) {
  const v = ev.target.value;
  if (!QUALITY_TIERS[v]) return;
  S.quality = v;
  saveQuality(v);
  const tier = QUALITY_TIERS[v];
  await tuneVideoSender(S.pc);
  pushMediaState();      // 顺手告诉对方，免得他以为是自己这边出了问题
  const tail = `约 ${fmtMB(tier.mbPerHour)}/小时。带宽紧张时先降清晰度、保住帧数。`;
  toast(S.media.video
    ? `画质已切到「${tier.label}」：你发出的画面${tail}`
    : `画质已设为「${tier.label}」，下次开视频生效：${tail}`, 4400);
}

function sendSignal(payload) {
  if (!S.remotePeerId) return;
  send({ type: 'signal', room: S.room, to: S.remotePeerId, payload });
}

/**
 * 收到的信令先过一道「对端是否已确定」的判断。
 *
 * 服务端是先给老设备广播 peer-joined、再把 peers 回给新设备，
 * 两条消息走的是两条不同的 WebSocket —— offer 完全可能比 peers 先到。
 * 此时新设备还不知道对方是谁，直接丢弃就会变成「偶发连不上，刷新才好」。
 * 所以先缓存，等对端身份确定后按序补投。
 */
function onIncomingSignal(senderId, payload) {
  if (!S.pc || !S.remotePeerId || S.remotePeerId !== senderId) {
    if (S.pending.length >= MAX_PENDING) S.pending.shift();   // 见 MAX_PENDING 注释
    S.pending.push({ senderId, payload, t: Date.now() });
    return;
  }
  applySignal(payload);
}

function flushPendingSignals() {
  if (!S.pc || !S.remotePeerId) return;
  const now = Date.now();
  const keep = [];
  for (const item of S.pending) {
    if (now - item.t > PENDING_TTL) continue;
    if (item.senderId === S.remotePeerId) applySignal(item.payload);
    else keep.push(item);
  }
  S.pending = keep;
}

/**
 * Perfect Negotiation（W3C 推荐写法）。
 * 两端在「同时改媒体」时会各发一个 offer（glare），必须有一方确定地让步：
 * polite 端回滚并接受对方的 offer，impolite 端忽略冲突。
 */
async function applySignal(payload) {
  const pc = S.pc;
  if (!pc) return;
  try {
    if (payload.description) {
      const desc = payload.description;
      const readyForOffer = !S.makingOffer &&
        (pc.signalingState === 'stable' || S.settingAnswer);
      const offerCollision = desc.type === 'offer' && !readyForOffer;

      S.ignoreOffer = !S.polite && offerCollision;
      if (S.ignoreOffer) return;

      S.settingAnswer = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      S.settingAnswer = false;

      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal({ description: pc.localDescription.toJSON() });
      }

    } else if (payload.candidate) {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch (e) {
        // 被忽略的 offer 对应的候选失败是预期的，别把它当错误抛出去
        if (!S.ignoreOffer) console.warn('ICE 候选添加失败', e);
      }

    } else if (payload.media) {
      S.remoteMedia = payload.media;
      if (QUALITY_TIERS[payload.quality]) S.remoteQuality = payload.quality;
      syncMediaUI();
      syncStage();
    }
  } catch (e) {
    console.warn('信令处理失败', e);
  }
}

/* ============================== 数据通道 ============================== */

function bindDataChannel(dc) {
  S.dc = dc;

  dc.onopen = () => {
    $('btn-send').disabled = false;
    pushMediaState();
    // 递名片：让对端认出（或认不出）你
    try { dc.send(JSON.stringify({ t: 'id', id: deviceId() })); } catch { /* noop */ }
    // 双方都就绪后再报「已连接」，避免 P2P 还没通就说连上了
    if (S.pc && S.pc.connectionState === 'connected') setStatus('online', '已连接');
    else setStatus('waiting', '信道已建立');
  };

  dc.onclose = () => { $('btn-send').disabled = true; };

  dc.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'msg') {
      addMessage(String(m.text ?? ''), 'them');
    } else if (m.t === 'media') {
      S.remoteMedia = { audio: !!m.media?.audio, video: !!m.media?.video };
      // 对方换了画质档位时说一声 —— 否则用户会以为画面变糊是自己这边的问题
      const q = QUALITY_TIERS[m.quality] ? m.quality : null;
      if (q && q !== S.remoteQuality) {
        S.remoteQuality = q;
        if (S.remoteMedia.video) {
          toast(`对方把画质调成了「${QUALITY_TIERS[q].label}」` +
                `（约 ${fmtMB(QUALITY_TIERS[q].mbPerHour)}/小时）—— 画面会小一些，但更不容易卡。`, 4400);
        }
      }
      syncMediaUI();
      syncStage();
    } else if (m.t === 'id') {
      onPeerIdentity(String(m.id || ''));
    }
  };
}

/* ============================== 对方身份 ============================== */

/**
 * 收到对方的名片后，判断这次来的是不是「上次那个人」。
 *
 * 三种结果：
 *   · 没有记录   → 首次，记下来，并**如实告诉用户「这是第一次」**
 *   · 和记录一致 → 熟人，安静，不打扰
 *   · 和记录不同 → 明确警告，并给出一键请出去的入口
 */
function onPeerIdentity(id) {
  if (!id) return;
  S.peerDeviceId = id;

  // 先前被我请出去过的设备又回来了 → 不建立通话，直接再请走
  if (getBlocked(S.room).includes(id)) {
    kickPeer('对方是你之前请出过的设备，已再次请出');
    return;
  }

  const known = getTrusted(S.room);
  if (!known) {
    setTrusted(S.room, id);
    showTrust('new', '这是和这台设备的第一次通话，已记住它。以后再进来会显示为「已确认」。');
  } else if (known === id) {
    // 熟人：只留一行极轻的确认，不打扰。但「请出房间」仍然可达 ——
    // 万一当初记住的就是个陌生人，用户得有反悔的入口。
    showTrust('ok', '已确认为熟悉的设备');
  } else {
    showTrust('warn',
      '⚠️ 这次进来的设备和你上次通话的不是同一台。如果对方换了手机或清了浏览器数据，忽略即可；否则请把它请出房间。');
  }
}

function showTrust(kind, text) {
  const bar = $('trust');
  if (!text) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.className = 'trust' + (kind ? ' ' + kind : '');
  $('trust-text').textContent = text;
  // 「记住这台」只在「设备变了」时有意义 —— 首次已经自动记住了
  $('trust-keep').hidden = kind !== 'warn';
  // 「请出房间」只要人还在房间里就一直可达：这是用户唯一的反悔手段，
  // 不能因为它藏起来而让人只能关掉页面或者干等
  $('trust-kick').hidden = false;
}

/**
 * 把当前对端请出房间，并记住它 —— 对方再进来会被自动请走。
 *
 * 为什么必须能踢：口令是共享秘密，谁拿到都能进。房间上限是 2，
 * 一旦被不认识的人占了位子，真正的对方就永远进不来（会撞到 room-full）。
 */
function kickPeer(note) {
  const target = S.remotePeerId;
  const dev = S.peerDeviceId;

  if (target) send({ type: 'kick', room: S.room, peerId: target });
  if (dev) addBlocked(S.room, dev);

  teardownPeer();
  S.remotePeerId = null;
  showTrust('', '');
  notice(note || '已把对方请出房间');
  setStatus('waiting', '等待对方接入');
}

function sendText(text) {
  if (!S.dc || S.dc.readyState !== 'open') return false;
  try {
    S.dc.send(JSON.stringify({ t: 'msg', text }));
    addMessage(text, 'me');
    return true;
  } catch {
    return false;
  }
}

function pushMediaState() {
  if (S.dc && S.dc.readyState === 'open') {
    try { S.dc.send(JSON.stringify({ t: 'media', media: S.media, quality: currentQuality() })); } catch { /* noop */ }
  }
}

/* ============================== 音视频 ============================== */

async function toggleMic() {
  if (!S.micTrack) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      S.micTrack = stream.getAudioTracks()[0];
      ensureLocalStream().addTrack(S.micTrack);
      if (S.pc) S.pc.addTrack(S.micTrack, S.localStream);   // addTrack 会触发重新协商
    } catch (e) {
      console.warn(e);
      toast('无法使用麦克风，请检查浏览器权限');
      return;
    }
  } else {
    S.micTrack.enabled = !S.micTrack.enabled;
  }
  S.media.audio = S.micTrack.enabled;
  pushMediaState();
  syncMediaUI();
}

async function toggleCam() {
  if (!S.camTrack) {
    try {
      // 采集端就采 720p：再往下的分辨率交给 scaleResolutionDownBy 在编码前压，
      // 这样切档是瞬时的（不用重启摄像头），「清晰」档也不会被采集上限锁死。
      // max 限死 30fps，避免高刷设备采到 60fps 白烧一倍编码。
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      S.camTrack = stream.getVideoTracks()[0];
      ensureLocalStream().addTrack(S.camTrack);
      if (S.pc) {
        S.pc.addTrack(S.camTrack, S.localStream);
        tuneVideoSender(S.pc);   // addTrack 之后补设一次码率上限
      }
      $('local-video').srcObject = S.localStream;
      $('local-video').play().catch(() => { /* noop */ });
    } catch (e) {
      console.warn(e);
      toast('无法使用摄像头，请检查浏览器权限');
      return;
    }
  } else {
    S.camTrack.enabled = !S.camTrack.enabled;
  }
  S.media.video = S.camTrack.enabled;
  pushMediaState();
  syncMediaUI();
  syncStage();
}

function ensureLocalStream() {
  if (!S.localStream) S.localStream = new MediaStream();
  return S.localStream;
}

function stopLocalMedia() {
  if (S.localStream) {
    for (const t of S.localStream.getTracks()) { try { t.stop(); } catch { /* noop */ } }
  }
  S.localStream = null;
  S.micTrack = null;
  S.camTrack = null;
  S.media = { audio: false, video: false };
  const lv = $('local-video');
  if (lv.srcObject) lv.srcObject = null;
}

/* ============================== 界面同步 ============================== */

function syncMediaUI() {
  const mic = $('btn-mic');
  const cam = $('btn-cam');

  mic.classList.toggle('on', S.media.audio);
  mic.setAttribute('aria-pressed', String(S.media.audio));
  mic.title = S.media.audio ? '关闭麦克风' : '打开麦克风';

  cam.classList.toggle('on', S.media.video);
  cam.setAttribute('aria-pressed', String(S.media.video));
  cam.title = S.media.video ? '关闭摄像头' : '打开摄像头';

  // 用 title 顺带把对端状态挂在按钮上，不占界面空间
  mic.dataset.peer = S.remoteMedia.audio ? 'on' : 'off';
  cam.dataset.peer = S.remoteMedia.video ? 'on' : 'off';
}

function syncStage() {
  const stage = $('stage');
  const lv = $('local-video');
  const anyVideo = S.media.video || S.remoteMedia.video;
  const anyAudio = S.media.audio || S.remoteMedia.audio;

  if (!anyVideo && !anyAudio) {
    stage.hidden = true;
    return;
  }
  stage.hidden = false;

  // 本地小窗只在真开了摄像头时显示，否则会是一个黑框
  lv.hidden = !S.media.video;

  const empty = $('stage-empty');
  const remoteVideoOn = S.remoteMedia.video;
  empty.hidden = remoteVideoOn;
  if (!remoteVideoOn) {
    empty.textContent = anyAudio && !anyVideo ? '语音通话中' : '对方还没打开摄像头';
  }
}

/* ============================== 排障钩子 ============================== */

/*
 * 只读状态出口，给自动化测试和排障用。
 * 刻意**不暴露**口令、房间号原文之外的东西：房间号本身已是派生值，
 * 而 S 里没有任何形式的明文口令。
 */
window.__rt = {
  get room() { return S.room; },
  get peerId() { return S.peerId; },
  get remotePeerId() { return S.remotePeerId; },
  get connectionState() { return S.pc ? S.pc.connectionState : null; },
  get dcOpen() { return !!(S.dc && S.dc.readyState === 'open'); },
  get media() { return { ...S.media }; },
  get remoteMedia() { return { ...S.remoteMedia }; },
  get peerDeviceId() { return S.peerDeviceId; },
  get trustShown() { return !$('trust').hidden; },
  get trustClass() { return $('trust').className; },
  get kickedCount() { return S.kickedCount; },
  get videoTuned() { return S.videoTuned; },
  get quality() { return currentQuality(); },
  get remoteQuality() { return S.remoteQuality; },

  /**
   * 视频发送端的真实参数 + 实时质量。
   *
   * 用途只有一个：**把「卡」归因**。看 qualityLimitation 这一个字段就够 ——
   *   · 'none'      没受限，卡顿来自网络丢包或对端
   *   · 'bandwidth' 带宽不够 → 降码率/降分辨率是正解
   *   · 'cpu'       编码算力不够 → 降码率没用，得降分辨率或帧率
   * 没有这个字段的话，调码率全靠猜。
   */
  async videoStats() {
    const out = { quality: currentQuality(), tuned: S.videoTuned, maxBitrate: null, scaleResolutionDownBy: null, degradationPreference: null };
    if (!S.pc) return out;
    const sender = S.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      try {
        const p = sender.getParameters();
        out.maxBitrate = p.encodings && p.encodings[0] ? p.encodings[0].maxBitrate : null;
        out.scaleResolutionDownBy = p.encodings && p.encodings[0] ? (p.encodings[0].scaleResolutionDownBy || 1) : null;
        out.degradationPreference = p.degradationPreference || null;
        const st = sender.track.getSettings();
        out.captureWidth = st.width || null;
        out.captureHeight = st.height || null;
        out.captureFps = st.frameRate || null;
      } catch { /* noop */ }
    }
    try {
      const stats = await S.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          out.fps = r.framesPerSecond != null ? r.framesPerSecond : null;
          out.width = r.frameWidth != null ? r.frameWidth : null;
          out.height = r.frameHeight != null ? r.frameHeight : null;
          out.bytesSent = r.bytesSent != null ? r.bytesSent : null;
          out.qualityLimitation = r.qualityLimitationReason || null;
        }
      });
    } catch { /* noop */ }
    return out;
  },

  get remoteVideoTracks() {
    const v = $('remote-video');
    return v.srcObject ? v.srcObject.getVideoTracks().length : 0;
  },
  get remoteAudioTracks() {
    const v = $('remote-video');
    return v.srcObject ? v.srcObject.getAudioTracks().length : 0;
  },

  get status() { return $('status').textContent; },
  get messages() {
    return [...document.querySelectorAll('#log .msg')].map((e) => ({ who: e.classList.contains('me') ? 'me' : 'them', text: e.textContent }));
  },

  /** 仅供自动化测试：模拟「浏览器判定这条连接已经死了」 */
  __dropSocket() { handleSocketLost(); },
};

/* ============================== 启动 ============================== */

function boot() {
  $('gate-form').addEventListener('submit', onSubmitPassphrase);

  $('toggle-pass').addEventListener('click', () => {
    const p = $('passphrase');
    const showing = p.type === 'text';
    p.type = showing ? 'password' : 'text';
    $('toggle-pass').textContent = showing ? '显示' : '隐藏';
    p.focus();
  });

  // 身份提示条上的两个动作
  $('trust-keep').addEventListener('click', () => {
    if (S.peerDeviceId) setTrusted(S.room, S.peerDeviceId);
    showTrust('', '');
    toast('已把这台设备记为对方');
  });
  $('trust-kick').addEventListener('click', () => kickPeer());

  $('composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('text');
    const text = input.value.trim();
    if (!text) return;
    if (sendText(text)) input.value = '';
    else toast('还没和对方接通，请稍候');
  });

  $('btn-mic').addEventListener('click', toggleMic);
  $('btn-cam').addEventListener('click', toggleCam);

  // 画质档位：存在本机，下次打开还是这个选择
  loadQuality();
  const qSel = $('video-quality');
  qSel.value = currentQuality();
  qSel.addEventListener('change', onQualityChange);

  $('btn-hangup').addEventListener('click', () => {
    // 先告诉对方一声，让他那边立刻收到 peer-left 而不是等超时
    send({ type: 'leave', room: S.room });
    backToGate();
  });

  $('dot').addEventListener('click', () => toast('房间号 ' + S.room.slice(0, 8) + '…'));

  // 回到前台时补一次保活：后台期间定时器被节流，连接很可能已经被回收
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.ws && S.ws.readyState === 1) {
      pingOnce();
    }
  });

  // 刷新后自动回到同一间房：房间号存在 sessionStorage 里，
  // 关掉标签页就没了 —— 想「用完即走」的时候它不会留下任何东西。
  const saved = sessionStorage.getItem('rt.room');
  if (saved && /^[0-9a-f]{32}$/.test(saved)) {
    enterRoom(saved);
  } else {
    $('passphrase').focus();
  }

  syncMediaUI();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
