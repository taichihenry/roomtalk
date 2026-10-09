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

/*
 * 对方信令断开后「等多久才宣布他真的走了」。
 * 分成两个值，因为这两件事的代价完全不同：
 *
 *   · 聊天态 1.5 秒足够 —— 就是躲一下重连抖动，本来也没什么可失去的。
 *   · 通话态必须给足产品对外承诺的重连窗口（20 秒）。⚠ 这是线上才暴露的问题：
 *     线上重连要走「退避 + WS 握手 + 重新注册」，远超 1.5 秒；而本地 wrangler dev
 *     在同进程里几十毫秒就重连完 —— 所以 1.5 秒在本地永远够用、线上必现误杀。
 *     表现就是「对方网络抖了一下，我这边通话被掐了」。
 *     更不该急着收的理由：**WebRTC 媒体是端到端的**，信令断了媒体往往还活着，
 *     一个正在进行的通话不该因为一次信令抖动就被判死刑。
 */
const PEER_LEFT_GRACE = 1_500;
const PEER_LEFT_GRACE_CALL = 20_000;
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
 * 文件 / 语音传输的参数。
 *
 * chat 这条 DataChannel 是 ordered: true（可靠 + 有序），所以分片天然按到达顺序
 * 拼得回去，不用自己做序号重排。但**背压必须自己做**：连着 dc.send 几十 MB 会瞬间
 * 把 bufferedAmount 顶爆然后抛错。所以切小片、盯着 bufferedAmount 走。
 */
/*
 * 分片取 64KB。
 *
 * 浏览器 SCTP 的单条消息上限普遍在 256KB 以上，64KB 远在安全区内；而相比
 * 16KB 的旧值，100MB 文件的 send 次数从 6400 次降到 1600 次 —— 每次 send 都有
 * 固定开销（跨进程投递 + 背压判断），片切得太碎会让大文件传起来明显发闷。
 * 上限仍是 1MB 缓冲，所以「一次顶爆 bufferedAmount」的风险不变。
 */
const XFER_CHUNK = 64 * 1024;
const XFER_HIGH = 1_000_000;        // 缓冲 > 1MB 就暂停，等降到 XFER_LOW 再继续
const XFER_LOW = 256 * 1024;
const XFER_MAX = 100 * 1024 * 1024; // 单文件上限 100MB；再大浏览器内存就吃不消了
const VOICE_MAX_MS = 60_000;        // 单条语音最长 60 秒（和微信一个量级）

/** 相邻消息间隔超过这么久，就插一条居中的时间分隔（微信的做法）。 */
const TIME_GAP_MS = 5 * 60_000;

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

/**
 * 自动取一个「设备名」，进房时随 join 一起报给服务端，双方都能看到对方是什么设备。
 *
 * 用途只有一个：**帮双方确认对面坐的是不是自己人**。口令是共享秘密，
 * 光看口令分不清进来的是 B 还是 C；但看到「对方 · Xiaomi 14」，双方就能
 * 口头核对一句「你那边显示的是什么」—— 这是纯口令方案能拿到的、最便宜的一道确认。
 *
 * 拿不到精确型号不是问题：能区分「手机 / 电脑 + 品牌机型」就够用了。
 * ⚠ 任何情况下都**不上报唯一标识**（那属于设备指纹，和这个产品「不留痕迹」冲突）——
 *   这里只取厂商型号这类公开、可重复、不指向个人的信息。
 */
function guessDeviceName() {
  const ua = navigator.userAgent;

  // Chromium 的 UA-CH：Android 上 model 就是真实机型（"Pixel 8"、"2201123C"…）
  try {
    const d = navigator.userAgentData;
    if (d && d.platform) {
      const p = d.platform;
      const model = (d.model || '').trim();
      if (p === 'Android') return model ? 'Android · ' + model : 'Android 手机';
      if (p === 'iOS') return /iPad/i.test(ua) ? 'iPad' : 'iPhone';
      if (p === 'Windows') return 'Windows 电脑';
      if (p === 'macOS') return 'Mac';
      if (p === 'Chrome OS' || p === 'Chromium OS') return 'Chromebook';
      if (p === 'Linux') return 'Linux 电脑';
    }
  } catch { /* 老浏览器没有 UA-CH，落到下面的 UA 解析 */ }

  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/i.test(ua)) {
    // 安卓 UA 里机型夹在 "Android 13; Pixel 8)" 或 "Android 13; SM-G991B Build/…" 之间
    const m = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\)|;)/);
    return m && m[1].trim() ? 'Android · ' + m[1].trim() : 'Android 手机';
  }
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux 电脑';
  return '未知设备';
}

/**
 * 异步补一次「高熵」UA-CH，把 Android 的真实机型要出来。
 *
 * ⚠ 低熵的 `navigator.userAgentData.model` **恒为空字符串** —— 机型属于高熵字段，
 *   必须显式调 `getHighEntropyValues(['model'])` 才会给。所以上面那份同步逻辑
 *   在 Android 上只够得出「Android 手机」，这里再补一次：拿到就用，拿不到维持原样。
 *
 * 补到之后如果已经进房了，顺手 rename 一次，让对方那边的显示也跟着更新。
 */
async function refineDeviceName() {
  try {
    const d = navigator.userAgentData;
    if (!d || typeof d.getHighEntropyValues !== 'function') return;
    const h = await d.getHighEntropyValues(['model', 'platform']);
    const model = String(h.model || '').trim();
    if (!model) return;                                  // 桌面端本来就没有机型字段
    S.myName = ((h.platform === 'Android' ? 'Android · ' : '') + model).slice(0, 24);
    syncMeta();
    if (S.started && S.ws && S.ws.readyState === 1) send({ type: 'rename', name: S.myName });
  } catch { /* 老浏览器没有 UA-CH，保持同步那份结果 */ }
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
function clearBlocked(room) {
  try { localStorage.removeItem(blockKey(room)); } catch { /* noop */ }
}

/*
 * 「自动请出」开关（只有房主用得上）。
 *
 * 背景是一个真实的翻车场景：房主手滑点错「请出房间」，对方就被记进黑名单，
 * 之后再进来自动被请走 —— 于是**永远也等不到对方**，而且退出重进都没用
 * （黑名单在 localStorage 里）。
 *
 * 所以把「自动 / 手动」交给房主自己定：
 *   · 自动（默认）—— 黑名单设备一进来就请走。口令被陌生人猜中时这是防线。
 *   · 手动        —— 只提示、不动手，由房主看着办。误请之后用它把人放回来。
 * 是设备级的个人偏好，不按房间存。
 */
const AUTOKICK_KEY = 'rt.autokick';

function loadAutoKick() {
  try { return localStorage.getItem(AUTOKICK_KEY) !== '0'; } catch { return true; }
}
function saveAutoKick(on) {
  try { localStorage.setItem(AUTOKICK_KEY, on ? '1' : '0'); } catch { /* noop */ }
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
  isHost: false,        // 我是不是房主（第一个进房的人）—— 只有房主能请人出去
  autoKick: true,       // 房主专属：黑名单设备再进来时是否自动请走（见 AUTOKICK_KEY）
  myName: '',           // 我这台设备的设备名（进房时上报给对端）
  peerName: '',         // 对端的设备名

  localStream: null,   // 本地音视频源（跨 PC 重建复用）
  remoteStream: null,
  micTrack: null,
  camTrack: null,
  videoTuned: false,    // 视频发送端参数（码率上限 / 降级偏好）是否已生效
  quality: null,        // 画质档位（'saver' | 'smooth' | 'sharp'）
  remoteQuality: null,  // 对端选的档位（只用来提示，不影响我这边）
  media: { audio: false, video: false },        // 本端开关状态
  remoteMedia: { audio: false, video: false },  // 对端开关状态
  facing: 'user',       // 摄像头朝向：'user' 前置 | 'environment' 后置
  camCount: 0,          // 探到的摄像头数量（>= 2 才显示「切换前后摄像头」）
  switchingCam: false,  // 正在换摄像头，防连点
  flipLog: [],          // 最近一次切换的步骤轨迹（给 __rt 看，手机上排障用）

  /* ---- 视频区布局 ---- */
  stageMain: null,      // 放大显示哪一格：null = 两格等分 | 'remote' | 'local'
  stagePicked: false,   // 用户是否**亲手**点过画面（点过就尊重他的选择，不再自动摆）
  pipHinted: false,     // 「点一下能放大」只提示一次（每通电话一次）

  pending: [],         // 对端未确定时先收到的信令
  peerLeftTimer: null,
  kickedCount: 0,      // 累计被请出次数（排障与自动化测试用）
  retry: 0,
  retryTimer: null,
  leaving: false,
  started: false,

  /* ---- 通话 / 播放 ---- */
  audioBlocked: false, // 浏览器拦住了自动播放（表现为「听不到对方」）
  ringKind: null,      // 正在响的来电类型：'audio' | 'video' | null
  ringTimer: null,

  /* ---- 进行中的通话 ----
   * callKind 是「通话态」的**唯一真相**：媒体开关（media.*）只表示我这边
   * 麦克风/摄像头开没开，而「有没有在通话」由 callKind 说了算。
   * 两者分开是必要的：视频通话里我能关掉摄像头继续通话（media.video=false
   * 但 callKind='video'），换成「有媒体就算在通话」就表达不了这件事。
   */
  callKind: null,      // null | 'audio' | 'video'
  callRinging: false,  // 我发起、对方还没接听
  callStartedAt: 0,    // 接通时刻（计时从这一刻起）
  callTimer: null,     // 界面上的时长刷新
  callOutTimer: null,  // 呼叫超时（对方一直不接）

  /* ---- 语音消息 ---- */
  recorder: null,      // 正在进行的 MediaRecorder
  recChunks: [],
  recStartedAt: 0,
  recTimer: null,      // 到点自动停
  recTimer2: null,     // 界面上的计时刷新
  voiceMode: false,    // 输入栏是否处于「按住说话」模式
  voiceHinted: false,  // 「按住说话」的操作提示只说一次

  /* ---- 文件 / 语音传输 ---- */
  rx: null,            // 正在接收的传输 { id, kind, name, mime, size, dur, chunks, got, el }
  rxCount: 0,          // 累计收到的文件/语音条数（排障与测试用）
  txCount: 0,          // 累计发出的文件/语音条数
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
  while (log.children.length > MAX_MESSAGES) {
    const old = log.firstElementChild;
    // 淘汰语音条时先把播放停掉：从 DOM 里摘掉并不会让 <audio> 停止发声，
    // 正在播的那条会变成「看不见却在响」
    const audio = old.querySelector && old.querySelector('audio');
    if (audio && !audio.paused) { try { audio.pause(); } catch { /* noop */ } }
    // 语音/文件气泡里挂着 blob: URL，撤掉 DOM 的同时必须 revoke，
    // 否则那几十 MB 的 Blob 会被一直引用着不放
    const a = old.querySelector && old.querySelector('audio, a[download]');
    const url = a && (a.src || a.href);
    if (url && url.startsWith('blob:')) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
    log.removeChild(old);
  }
  scrollLog();
}

/*
 * 时间分隔（微信那条居中的小灰条）。
 *
 * 只在「和上一条消息隔得够久」时才插 —— 每句都插一条时间等于没插，
 * 反而把对话切碎。
 */
let lastMsgAt = 0;

function timeLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function maybeTimeSeparator() {
  const now = Date.now();
  if (now - lastMsgAt < TIME_GAP_MS) return;
  const el = document.createElement('div');
  el.className = 'time';
  el.textContent = timeLabel(now);
  appendToLog(el);
  lastMsgAt = now;
}

function notice(text) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = text;
  appendToLog(el);
}

/** 文本气泡。带 .text 类，便于排障钩子只挑出文本消息。 */
function addMessage(text, who) {
  maybeTimeSeparator();
  const el = document.createElement('div');
  el.className = 'msg text ' + who;
  el.textContent = text;          // textContent，天然免疫 XSS
  appendToLog(el);
  lastMsgAt = Date.now();
}

/* ---------------- 体量 / 时长格式化 ---------------- */

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtDur(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}′${String(s % 60).padStart(2, '0')}″` : `${s}″`;
}

/* ---------------- 语音 / 文件气泡 ---------------- */

/**
 * 语音消息气泡：一个播放按钮 + 时长，点一下播放。
 *
 * 音频本身是走 DataChannel 端到端过来的（Blob），存在内存里、不落盘 ——
 * 刷新页面就没了。这符合「消息不存储」的产品边界。
 */
function addVoice(blob, who, dur) {
  maybeTimeSeparator();
  const el = document.createElement('div');
  el.className = 'msg voice ' + who;

  const wave = document.createElement('span');
  wave.className = 'voice-wave';

  const durEl = document.createElement('span');
  durEl.className = 'voice-dur';
  durEl.textContent = fmtDur(dur || 0);

  const audio = document.createElement('audio');
  const url = URL.createObjectURL(blob);
  audio.src = url;
  audio.preload = 'metadata';
  audio.hidden = true;

  el.append(wave, durEl, audio);
  el.title = '点击播放';
  el.addEventListener('click', () => {
    if (audio.paused) {
      audio.currentTime = 0;
      audio.play().then(() => { el.classList.add('playing'); })
        .catch(() => toast('播放失败'));
    } else {
      audio.pause();
      el.classList.remove('playing');
    }
  });
  audio.addEventListener('ended', () => {
    el.classList.remove('playing');
    audio.currentTime = 0;
  });

  appendToLog(el);
  lastMsgAt = Date.now();
  return el;
}

/** 文件消息气泡：图标 + 文件名 + 体积，点一下另存。 */
function addFile(blob, name, who) {
  maybeTimeSeparator();
  const el = document.createElement('div');
  el.className = 'msg file ' + who;

  const ico = document.createElement('span');
  ico.className = 'file-ico';
  ico.textContent = fileIcon(name);

  const meta = document.createElement('span');
  meta.className = 'file-meta';
  const nm = document.createElement('span');
  nm.className = 'file-name';
  nm.textContent = name || '文件';
  const sz = document.createElement('span');
  sz.className = 'file-size';
  sz.textContent = fmtBytes(blob.size);
  meta.append(nm, sz);

  // 一律用 <a download> 让人自己决定要不要存 —— 「不存储」是这个产品的底线，
  // 所以不做「自动打开」这种喧宾夺主的事。
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name || 'file';
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = '点击保存';
  link.append(ico, meta);

  el.appendChild(link);
  appendToLog(el);
  lastMsgAt = Date.now();
  return el;
}

function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return '🖼';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(ext)) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['txt', 'md', 'json', 'js', 'ts', 'html', 'css', 'py', 'java', 'go', 'rs'].includes(ext)) return '📄';
  return '📎';
}

/** 传输进度气泡：返回一个可更新百分比的小组件。 */
function addProgress(who, label) {
  maybeTimeSeparator();
  const el = document.createElement('div');
  el.className = 'msg progress ' + who;

  const txt = document.createElement('span');
  txt.className = 'progress-pct';
  txt.textContent = label;

  const bar = document.createElement('span');
  bar.className = 'progress-bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);

  el.append(txt, bar);
  appendToLog(el);
  return {
    el,
    set(pct) {
      fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      txt.textContent = Math.round(pct) + '%';
    },
    done() {
      el.remove();
    },
  };
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
  if (!S.myName) S.myName = guessDeviceName().slice(0, 24);
  S.peerName = '';
  $('gate').hidden = true;
  $('room').hidden = false;
  $('log').innerHTML = '';
  setStatus('waiting', '正在连接…');
  syncMeta();
  connect();
  $('text').focus();
}

function backToGate() {
  S.leaving = true;
  S.started = false;
  S.isHost = false;
  S.peerName = '';
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
    send({ type: 'join', room: S.room, clientId: clientId(), name: (S.myName || guessDeviceName()).slice(0, 24) });
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
      // 房主身份由服务端判定：第一个进房的人是房主，只有他能请人出去。
      // 「谁先退出谁让位」—— 所以这行也可能是 host=false。
      S.isHost = !!m.host;
      setStatus('waiting', '等待对方接入');
      reflectHostUI();
      break;

    case 'host':
      // 原房主退出了，我接任 —— 这时才把「请出房间」的入口给我
      S.isHost = !!m.host;
      reflectHostUI();
      break;

    case 'room-error':
      // 房间满了 / 服务器繁忙：都不该自动重试，直接把话说清楚并退回入口
      failToGate(m.reason || '无法进入这个房间');
      break;

    case 'peers':
      // 房里已经有人 → 他是主叫方，我应答
      if (Array.isArray(m.peers) && m.peers.length) {
        S.peerName = m.peers[0].name || '';
        syncMeta();
        setStatus('waiting', '已找到对方，正在建立连接…');
        preparePeer(m.peers[0].id, false);
      }
      break;

    case 'peer-joined':
      // 有人进来了 → 我主叫
      // 之前挂着 peerLeftTimer 说明刚刚经历过一次「等待对方重连」；这通电话要是
      // 还没断，就明确告诉用户「接回来了」—— 不然他只知道断过、不知道已经好了。
      if (S.peerLeftTimer && inCall()) notice('对方已重新接入，通话继续');
      clearTimeout(S.peerLeftTimer);
      S.peerLeftTimer = null;
      S.peerName = m.peer.name || '';
      syncMeta();
      setStatus('waiting', '已找到对方，正在建立连接…');
      preparePeer(m.peer.id, true);
      break;

    case 'peer-left':
      // reason === 'leave' 是「对方主动退房，他不会再回来了」→ 立刻收摊；
      // 缺省（'closed'）是「连接断了」→ 交给 handlePeerLeft 按状态给宽限期。
      if (m.peerId === S.remotePeerId) handlePeerLeft(m.reason === 'leave');
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
      // 对端补报/改了自己的设备名（例如异步拿到真实机型之后再报一次）
      if (m.peerId === S.remotePeerId) { S.peerName = m.name || ''; syncMeta(); }
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

function handlePeerLeft(byChoice = false) {
  const reallyGone = () => {
    teardownPeer();
    dismissRing();
    // 对端真走了 → 通话也结束：本地媒体必须收掉，否则摄像头指示灯一直亮着
    stopLocalMedia();
    S.remotePeerId = null;
    S.peerName = '';
    syncMeta();
    notice('对方已离开');
    setStatus('waiting', '等待对方接入');
  };

  // 对方**主动退房**（点了 ✕）：不存在「他马上回来」这回事 —— 即使回来也是后进者、
  // 是新的一轮。所以立刻收摊，别让人对着一个已经空了的房间干等 20 秒。
  //
  // ⚠ 这条路径不能只靠端到端的 bye：bye 走 DataChannel 的 send() 是排队的，
  // 退房时紧接着就 teardownPeer() 把连接拆了，那条 bye 经常还没出网就被丢掉。
  // 服务端在 peer-left 上带的 reason 才是可靠信号（它走 WS，先发后关）。
  if (byChoice) {
    clearTimeout(S.peerLeftTimer);
    S.peerLeftTimer = null;
    reallyGone();
    return;
  }

  // 意外断开：等一小会儿再宣布 —— 对端可能只是断线重连，马上就会带新身份回来。
  // 通话中这个「一小会儿」要长得多（见 PEER_LEFT_GRACE_CALL 的说明）：信令断了
  // 不等于媒体断了，一次网络抖动不该把正在进行的通话掐掉。等待期间给用户一句
  // 交代，否则画面卡住却毫无解释，只会让人以为「卡死了」。
  const grace = inCall() ? PEER_LEFT_GRACE_CALL : PEER_LEFT_GRACE;
  if (inCall()) notice('对方连接中断，正在等待重连…');
  clearTimeout(S.peerLeftTimer);
  S.peerLeftTimer = setTimeout(reallyGone, grace);
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
  // 通道没了，正在传的东西不可能再传完 —— 状态机要清掉，否则下一段二进制
  // 会被错拼进上一条没收完的文件里
  if (S.rx) { if (S.rx.progress) S.rx.progress.done(); S.rx = null; }
  // ⚠ 这里**不**清 S.peerName：teardownPeer 管的是「WebRTC 连接」，
  //   不是「对面是谁」。而且 preparePeer() 内部就会调它 —— 清掉的话，
  //   刚在 peer-joined 里拿到的设备名会被自己立刻抹掉。
  //   对端真的走了才清，那两处是 handlePeerLeft 和 kickPeer。
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
    // 一定要走 ensureRemotePlayback：静默 catch 会把「自动播放被拦」
    // 变成用户眼里的「对方没开麦」
    ensureRemotePlayback();
    if (ev.track.kind === 'video') {
      ev.track.addEventListener('ended', () => {
        // 对端的视频轨真的断了（摄像头被别的程序抢走、或对面直接关了摄像头）。
        // 不能立刻改状态：重新协商时旧轨也会 ended，紧接着就来新轨，
        // 马上置 false 会让画面闪一下。等一拍再确认还有没有活着的视频轨。
        setTimeout(() => {
          const rv2 = $('remote-video');
          const live = !!(rv2.srcObject && rv2.srcObject.getVideoTracks
            && rv2.srcObject.getVideoTracks().some((t) => t.readyState === 'live'));
          // 只有「之前确实在显示画面」才提示一句，避免重协商时误报
          if (!live && S.remoteMedia.video) {
            S.remoteMedia.video = false;
            notice('对方的摄像头已关闭');
            syncStage();
          }
        }, 400);
      });
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
  // 二进制分片按 ArrayBuffer 收，省掉一次 Blob→ArrayBuffer 的转换
  dc.binaryType = 'arraybuffer';

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
    // 裸二进制 = 文件 / 语音的分片，按「当前正在收的那一条」累加
    if (ev.data instanceof ArrayBuffer) {
      const rx = S.rx;
      if (!rx) return;
      rx.chunks.push(ev.data);
      rx.got += ev.data.byteLength;
      if (rx.progress && rx.size) rx.progress.set((rx.got / rx.size) * 100);
      if (rx.got >= rx.size) finishRx();
      return;
    }

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
    } else if (m.t === 'ring') {
      onRing(m);
    } else if (m.t === 'ring-answer') {
      onRingAnswer(m);
    } else if (m.t === 'bye') {
      // 对方挂断了。立收回自己的麦克风/摄像头并退出通话界面 ——
      // 只把界面收起来不停媒体，摄像头指示灯会一直亮着。
      onBye();
    } else if (m.t === 'xfer') {
      onXferCtl(m);
    }
  };
}

/* ============================== 对方身份 ============================== */

/**
 * 收到对方的名片后，判断这次来的是不是「上次那个人」。
 *
 * 三种结果：
 *   · 没有记录   → 第一次，**如实说明，并把「要不要记住」交给用户点**
 *   · 和记录一致 → 熟人，安静，不打扰
 *   · 和记录不同 → 明确警告，并给出一键请出去的入口
 *
 * ⚠ 首访**绝不自动记住**。「谁先进房谁就是自己人」是最糟的信任模型：
 *   口令是共享秘密，不速之客只要赶在真正的对方之前进来，就会被永久标记成
 *   「已确认」—— 之后真正的对方反而成了「设备变过」的可疑对象。所以第一次
 *   只报告事实，是否收下这台设备由用户按一下决定（TOFU 也要用户点头）。
 */
function onPeerIdentity(id) {
  if (!id) return;
  S.peerDeviceId = id;

  // 先前被我请出去过的设备又回来了。
  // 拉黑名单是**房主**的名单，所以只有房主用得上它；不是房主时请不动
  // （服务端也会拒绝），这时如实告诉用户「你没法请走它，只能自己退出」。
  if (getBlocked(S.room).includes(id)) {
    if (!S.isHost) {
      showTrust('warn', '⚠️ 对方是你之前请出过的设备，但你不是先进入房间的一方，无法请走它。你可以直接退出房间。');
      $('trust-keep').hidden = true;      // 它在你的黑名单里，再给「记住这台」是自相矛盾的
    } else if (S.autoKick) {
      kickPeer('对方是你之前请出过的设备，已再次请出');
    } else {
      // 房主把「自动请出」关了 → 只提示，不动手，由他自己决定
      showTrust('warn', '⚠️ 对方是你之前请出过的设备。你已经关掉了自动请出：要赶人请点「请出房间」，想放他进来就不用管。');
      $('trust-keep').hidden = true;
    }
    return;
  }

  const known = getTrusted(S.room);
  if (!known) {
    // 第一次：只说事实，不代用户做决定
    showTrust('first',
      '这是和这台设备的第一次通话。如果确认对方就是约好的人，可以点「记住这台设备」——下次它进来会显示「已确认」。');
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
  bar.hidden = !text;
  if (text) {
    bar.className = 'trust' + (kind ? ' ' + kind : '');
    $('trust-text').textContent = text;
    // 「记住这台设备」在两种情况下有意义：第一次见到它（待用户确认），
    // 以及这次换了一台（用户可以把记录更新过去）。
    $('trust-keep').hidden = !(kind === 'first' || kind === 'warn');
  }
  reflectHostUI();
}

/**
 * 刷新设备名条：我是什么设备 / 对方是什么设备。
 *
 * 口令是共享秘密，光看口令分不清进来的是约好的那个人还是别人。
 * 设备名做不到「认证」，但它给了一次**口头核对**的机会 ——
 * 「你那边显示的是什么？」—— 这已经是纯口令方案能拿到的最便宜的一道确认。
 */
function syncMeta() {
  $('meta-self').textContent = S.myName || '—';
  $('meta-other').textContent = S.peerName || '未进入';
  reflectHostUI();
}

/**
 * 刷新房主专属的三个控件。
 *
 * 只有第一个进入房间的人（房主）能请人出去 —— 后进来的一方连按钮都不显示。
 * 服务端会独立校验，前端隐藏只是不让用户白点一下。
 *
 * 三个控件：
 *   · 请出房间     —— 只有房主有
 *   · 自动请出开关 —— 房主用来自选「拉黑设备再进来是自动赶走还是我自己看着办」
 *   · 解除拉黑     —— 误请之后的兜底出口（把拉黑名单整个清掉）
 */
function reflectHostUI() {
  $('trust-kick').hidden = !S.isHost;
  $('autokick-wrap').hidden = !S.isHost;
  $('autokick').checked = S.autoKick;
  $('btn-unblock').hidden = !(S.isHost && getBlocked(S.room).length > 0);
}

/**
 * 把当前对端请出房间。
 *
 * ⚠ **只有房主（第一个进房的人）能请人出去。** 后进来的一方没有这个能力，
 * 这里做了双重保险：不是房主就直接不动（服务端 _handleKick 也会独立校验，
 * 绕不过去）。
 *
 * 是否**顺手拉黑**由「自动请出」开关决定：
 *   · 开着（默认）→ 记进黑名单，对方再进来自动请走。防陌生人反复试口令。
 *   · 关着        → 只请出这一次。手滑点错之后，对方还能正常回来找你。
 *
 * 为什么必须能踢：口令是共享秘密，谁拿到都能进。房间上限是 2，
 * 一旦被不认识的人占了位子，真正的对方就永远进不来（会撞到 room-full）。
 */
function kickPeer(note) {
  if (!S.isHost) {
    toast('只有先进入房间的一方能请人出去');
    return;
  }
  const target = S.remotePeerId;
  const dev = S.peerDeviceId;

  if (target) send({ type: 'kick', room: S.room, peerId: target });
  if (dev && S.autoKick) addBlocked(S.room, dev);

  teardownPeer();
  // 人被赶走了，通话自然也没了 —— 顺手收掉本地媒体，别让摄像头对着空房间
  stopLocalMedia();
  S.remotePeerId = null;
  S.peerName = '';          // teardownPeer 刻意不管这个，见那里的说明
  showTrust('', '');
  syncMeta();
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
  // 还在「正在呼叫」阶段就先别报 —— 否则对方还没接，界面就会先一步显示
  // 「对方开着麦克风」，而他的聊天窗口并不该因为一个还没接的呼叫进入通话态。
  // 接通那一刻（onRingAnswer / acceptRing）会补一次。
  if (S.callRinging) return;
  sendCtl({ t: 'media', media: S.media, quality: currentQuality() });
}

/* ============================== 语音消息 ============================== */

/**
 * 挑一个当前浏览器支持的录音格式。
 *
 * 没有统一答案：Chrome/Android 给 webm/opus，Safari 只给 mp4/aac。
 * 所以按优先级探一遍，都不支持就交给浏览器自选（传给构造函数 undefined）。
 */
function pickAudioMime() {
  if (!window.MediaRecorder) return '';
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const c of cands) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* 继续试 */ }
  }
  return '';
}

let recEl = null;

function showRecHud() {
  if (recEl) recEl.remove();
  recEl = document.createElement('div');
  recEl.className = 'rec-hud';

  const dot = document.createElement('span');
  dot.className = 'rec-dot';

  const time = document.createElement('span');
  time.className = 'rec-time';
  time.textContent = '0:00';

  const hint = document.createElement('span');
  hint.className = 'rec-hint';
  hint.textContent = '松手发送';

  recEl.append(dot, time, hint);
  document.body.appendChild(recEl);

  const tick = () => {
    if (!recEl) return;
    const s = Math.floor((Date.now() - S.recStartedAt) / 1000);
    const left = Math.max(0, Math.ceil((VOICE_MAX_MS - (Date.now() - S.recStartedAt)) / 1000));
    time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      + (left <= 10 ? ` · 还剩 ${left}s` : '');
  };
  tick();
  clearInterval(S.recTimer2);
  S.recTimer2 = setInterval(tick, 250);
}

/**
 * 开始录音（按住说话）。
 *
 * 用 pointerdown/pointerup 而不是 click：微信那种「按住录、松手发」必须同时知道
 * 按下和抬起两个时刻。pointer 事件一套代码同时覆盖鼠标、触摸、手写笔。
 */
async function startRecord() {
  if (S.recorder) return;
  if (!connected()) { toast('还没和对方接通'); return; }
  if (!window.MediaRecorder) { toast('这台设备的浏览器不支持录音'); return; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch { toast('无法使用麦克风'); return; }

  const mime = pickAudioMime();
  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch {
    try { rec = new MediaRecorder(stream); } catch { toast('这台设备不支持录音'); stream.getTracks().forEach((t) => t.stop()); return; }
  }

  S.recChunks = [];
  S.recStartedAt = Date.now();
  S.recorder = rec;
  rec._cancelled = false;

  rec.ondataavailable = (e) => { if (e.data && e.data.size) S.recChunks.push(e.data); };

  rec.onstop = async () => {
    const dur = Date.now() - S.recStartedAt;
    for (const t of stream.getTracks()) { try { t.stop(); } catch { /* noop */ } }
    clearInterval(S.recTimer2); S.recTimer2 = null;
    S.recorder = null;
    if (recEl) { recEl.remove(); recEl = null; }

    const blob = new Blob(S.recChunks, { type: rec.mimeType || 'audio/webm' });
    const cancelled = rec._cancelled;
    S.recChunks = [];

    if (cancelled || dur < 500 || blob.size < 600) {
      if (!cancelled) toast('说话时间太短，已取消');
      return;
    }
    const capped = Math.min(dur, VOICE_MAX_MS);
    const el = addVoice(blob, 'me', capped);
    if (await sendXfer('voice', blob, { mime: blob.type, dur: capped })) S.txCount++;
    else { el.classList.add('failed'); toast('这条语音没发出去'); }
  };

  rec.start();
  showRecHud();
  // 到点自动停，免得一直占着麦克风
  S.recTimer = setTimeout(() => stopRecord(), VOICE_MAX_MS);
}

function stopRecord(cancel) {
  clearTimeout(S.recTimer);
  S.recTimer = null;
  const rec = S.recorder;
  if (!rec) return;
  if (cancel) rec._cancelled = true;
  try { rec.stop(); } catch { /* 已经开始停了 */ }
}

/* ============================== 文件 / 语音传输 ============================== */

/**
 * 沿 DataChannel 发一个 Blob（分片 + 背压）。
 *
 * 协议是三段式的，靠「控制消息 + 裸二进制」混跑：
 *   {t:'xfer', phase:'begin', ...元信息}  →  若干 ArrayBuffer 分片  →  {phase:'end'}
 * chat 通道是 ordered:true，二进制必然落在 begin 和 end 之间，所以接收端
 * 用一个「当前正在收的传输」状态机就够了，不需要序号。
 *
 * ⚠ 背压是必须的：DataChannel 的缓冲没有上限保护，一次 dc.send 几十 MB
 *   会瞬间把 bufferedAmount 顶爆并抛错。所以盯着 bufferedAmount 走。
 */
async function sendXfer(kind, blob, meta) {
  const dc = S.dc;
  if (!dc || dc.readyState !== 'open') return false;

  const id = crypto.randomUUID();
  const begin = {
    t: 'xfer', phase: 'begin', id, kind,
    name: meta.name || '', mime: meta.mime || blob.type || '',
    size: blob.size, dur: meta.dur || 0,
  };
  try { dc.send(JSON.stringify(begin)); } catch { return false; }

  // 小东西（几 KB 的文字文件、几秒的语音）眨眼就发完了，给它挂个进度条
  // 只会闪一下，反而显得卡。超过 256KB 才显示进度。
  const showProgress = blob.size > 256 * 1024;
  const progress = showProgress ? addProgress('me', kind === 'voice' ? '发送语音…' : '发送中…') : null;
  dc.bufferedAmountLowThreshold = XFER_LOW;

  let sent = 0;
  try {
    while (sent < blob.size) {
      if (dc.readyState !== 'open') throw new Error('channel closed');
      if (dc.bufferedAmount > XFER_HIGH) await waitDrain(dc);
      const buf = await blob.slice(sent, sent + XFER_CHUNK).arrayBuffer();
      if (!buf.byteLength) break;
      dc.send(buf);
      sent += buf.byteLength;
      if (progress && blob.size) progress.set((sent / blob.size) * 100);
    }
    dc.send(JSON.stringify({ t: 'xfer', phase: 'end', id }));
  } catch (e) {
    console.warn('传输中断', e);
    if (progress) progress.done();
    toast('传输中断了');
    return false;
  }
  if (progress) progress.done();
  return true;
}

/** 等 bufferedAmount 降到低水位。带 3 秒兜底，避免事件万一不来就永久卡住。 */
function waitDrain(dc) {
  return new Promise((resolve) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    dc.addEventListener('bufferedamountlow', done);
  });
}

/** 收到传输控制消息。 */
function onXferCtl(m) {
  if (m.phase === 'begin') {
    if (m.size > XFER_MAX) {
      toast(`对方要发的东西太大了（${fmtBytes(m.size)}），超过 100MB 上限`);
      sendCtl({ t: 'xfer', phase: 'abort', id: m.id });
      return;
    }
    S.rx = {
      id: m.id, kind: m.kind, name: m.name || '', mime: m.mime || '',
      size: m.size, dur: m.dur || 0, chunks: [], got: 0,
      progress: (m.kind === 'file' && m.size > 256 * 1024) ? addProgress('them', '接收中…') : null,
    };
  } else if (m.phase === 'end') {
    finishRx();
  } else if (m.phase === 'abort') {
    if (S.rx) { if (S.rx.progress) S.rx.progress.done(); S.rx = null; }
  }
}

/** 收完了：拼成 Blob 并落成一条气泡。 */
function finishRx() {
  const rx = S.rx;
  if (!rx) return;
  S.rx = null;
  if (rx.progress) rx.progress.done();
  const blob = new Blob(rx.chunks, { type: rx.mime || 'application/octet-stream' });
  rx.chunks = [];
  if (rx.kind === 'voice') addVoice(blob, 'them', rx.dur);
  else addFile(blob, rx.name || '文件', 'them');
  S.rxCount++;
}

/* ---------------------------- 语音模式 / 发文件 ---------------------------- */

function setVoiceMode(on) {
  S.voiceMode = on;
  $('btn-voice').classList.toggle('on', on);
  $('btn-voice').setAttribute('aria-pressed', String(on));
  $('btn-voice').title = on ? '切换到键盘' : '切换到语音';
  $('text').hidden = on;
  $('hold-talk').hidden = !on;
  $('btn-send').hidden = on;
  // .voice 一挂上，那颗话筒就从长条变成居中的大圆（见 app.css）——
  // 手机上长条按不住，圆形落点稳得多
  $('composer').classList.toggle('voice', on);
  if (!on) $('text').focus();
  else if (!S.voiceHinted) {
    S.voiceHinted = true;
    toast('按住圆形按钮说话，松手发送', 3200);
  }
}

async function sendFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (!connected()) { toast('还没和对方接通，请稍候'); return; }
  for (const f of files) {
    if (f.size > XFER_MAX) { toast(`「${f.name}」有 ${fmtBytes(f.size)}，超过 100MB 上限`); continue; }
    if (await sendXfer('file', f, { name: f.name, mime: f.type })) {
      S.txCount++;
      addFile(f, f.name, 'me');
    } else break;
  }
}

/* ============================== 音视频 ============================== */

function connected() { return !!(S.dc && S.dc.readyState === 'open'); }

/** 给对端发一条走 DataChannel 的控制消息（端到端，服务器不经手）。 */
function sendCtl(obj) {
  if (!connected()) return false;
  try { S.dc.send(JSON.stringify(obj)); return true; } catch { return false; }
}

/**
 * 打开麦克风（幂等）。已经开过就直接置回 enabled，不再二次申请权限。
 *
 * 时间戳顺序很讲究：**先 addTrack，再置 S.media.audio**。
 * addTrack 会触发 onnegotiationneeded → 发 offer，对方那边随即 ontrack；
 * 如果标志位早于 offer 落地，对方可能先收到 media 状态、后收到轨道，中间那一下
 * 会短暂显示「对方开着麦但听不到」—— 虽然只闪一下，但正好是用户会截图来问的那种。
 */
async function ensureMic() {
  if (S.micTrack) {
    S.micTrack.enabled = true;
    S.media.audio = true;
    syncMediaUI(); syncStage(); pushMediaState();
    return true;
  }
  try {
    // 通话场景把三个处理都打开：不加回声消除，对方会听到自己的声音绕回来
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    S.micTrack = stream.getAudioTracks()[0];
    ensureLocalStream().addTrack(S.micTrack);
    if (S.pc) S.pc.addTrack(S.micTrack, S.localStream);
  } catch (e) {
    console.warn(e);
    toast(e && e.name === 'NotAllowedError'
      ? '麦克风被浏览器拦下了。点地址栏左边的权限图标允许后再试。'
      : '无法使用麦克风，请检查设备与权限');
    return false;
  }
  S.media.audio = true;
  syncMediaUI(); syncStage(); pushMediaState();
  return true;
}

/** 打开摄像头（幂等）。 */
async function ensureCam() {
  if (S.camTrack) {
    S.camTrack.enabled = true;
    S.media.video = true;
    const lv = $('local-video');
    lv.srcObject = S.localStream;
    lv.play().catch(() => { /* noop */ });
    applyMirror();
    syncMediaUI(); syncStage(); pushMediaState();
    return true;
  }
  try {
    // 采集端就采 720p：再往下的分辨率交给 scaleResolutionDownBy 在编码前压，
    // 这样切档是瞬时的（不用重启摄像头），「清晰」档也不会被采集上限锁死。
    // max 限死 30fps，避免高刷设备采到 60fps 白烧一倍编码。
    // 约束统一走 videoConstraints：默认按「前置」要，但只用 ideal —— 单摄设备照样开得起来
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(S.facing) });
    S.camTrack = stream.getVideoTracks()[0];
    ensureLocalStream().addTrack(S.camTrack);
    if (S.pc) {
      S.pc.addTrack(S.camTrack, S.localStream);
      tuneVideoSender(S.pc);   // addTrack 之后补设一次码率上限
    }
    const lv = $('local-video');
    lv.srcObject = S.localStream;
    lv.play().catch(() => { /* noop */ });
  } catch (e) {
    console.warn(e);
    toast(e && e.name === 'NotAllowedError'
      ? '摄像头被浏览器拦下了。点地址栏左边的权限图标允许后再试。'
      : '无法使用摄像头，请检查设备与权限');
    return false;
  }
  S.media.video = true;
  applyMirror();
  refreshCamCount();     // 拿到权限后才数得准：按钮该不该露，现在才知道
  syncMediaUI(); syncStage(); pushMediaState();
  return true;
}

/* ---------------------------- 摄像头朝向 ---------------------------- */

/**
 * 采集约束。
 *
 * `facing` 为什么默认按 **ideal** 传：桌面机、单摄笔记本上根本没有「后置摄像头」
 * 这个概念，写成 `exact` 会直接抛 OverconstrainedError，把整条视频路打死。
 * ideal 的语义是「能这样最好，不行就随便给一个」—— 这正是我们要的。
 * 只有用户**主动点切换**时才用 exact（那时他想换就一定得换成，见 flipCamera）。
 */
function videoConstraints(facing, exact = false) {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    ...(facing ? { facingMode: exact ? { exact: facing } : { ideal: facing } } : {}),
  };
}

/** 前置镜像、后置不镜像。见 CSS 里 .pane video#local-video.mirror */
function applyMirror() {
  const lv = $('local-video');
  if (lv) lv.classList.toggle('mirror', S.facing !== 'environment');
}

/**
 * 数一下这台设备有几颗摄像头，决定「切换前后摄像头」按钮露不露。
 *
 * 桌面外接单摄、以及只有一颗摄像头的设备上，露出来只会让人白点一次
 * 然后收到一句失败提示 —— 不如一开始就不显示。
 */
async function refreshCamCount() {
  let n = 0;
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    n = list.filter((d) => d.kind === 'videoinput').length;
  } catch { /* 拿不到就当作 0：按钮不显示，功能不受影响 */ }
  S.camCount = n;
  // 按钮只在「正在视频通话 + 真有 >= 2 颗摄像头」时才露。
  // 桌面单摄笔记本上没它什么事，语音通话里更没有。
  const b = $('btn-flip');
  if (b) b.hidden = !(n >= 2 && S.callKind === 'video');
}

/** 「设备忙 / 读不到」类错误 —— 只有这类才值得「先释放旧摄像头再重试」 */
const CAM_BUSY_ERR = new Set([
  'NotReadableError', 'TrackStartError', 'AbortError', 'SourceUnavailableError',
]);

/** 把 getUserMedia 的错误翻成用户能照做的一句话 */
function camErrText(e) {
  const n = (e && e.name) || '';
  if (CAM_BUSY_ERR.has(n)) return '摄像头被占用，请关掉相机、微信等再用';
  if (n === 'NotAllowedError' || n === 'SecurityError') return '没有摄像头权限';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return '这台设备没有另一颗摄像头';
  return '这台设备可能只有一颗摄像头';
}

/** 取 pc 上的视频发送端（可能还没有：视频没接进通话时是 null） */
function videoSenderOf(pc) {
  if (!pc) return null;
  return pc.getSenders().find((s) => s.track && s.track.kind === 'video') || null;
}

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 按 deviceId 挑「另一颗」摄像头并打开；挑不出来、或打不开，一律返回 null。
 * 失败原因 push 进 errs（调用方据此判断值不值得「先释放再重试」）。
 */
async function openOtherCamera(facing, excludeId, excludeLabel, errs) {
  let devs = [];
  try {
    devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch (e) { errs.push(e); return null; }

  // 排除当前那颗。deviceId 拿不到时退用 label；**两者都拿不到就宁可放弃** ——
  // 此时「另一颗」根本无从分辨，瞎取会换到正在用的那颗，用户看到的就是
  // 「点了没反应」，比明确报一句失败更糟。
  let others;
  if (excludeId) others = devs.filter((d) => d.deviceId && d.deviceId !== excludeId);
  else if (excludeLabel) others = devs.filter((d) => d.deviceId && d.label !== excludeLabel);
  else others = [];
  if (!others.length) return null;

  // 有名字时按名字挑（授权后 label 才非空）；没名字而只排除出一颗，那它就是答案。
  // label 覆盖中英日文各种写法：Android 给 "Camera 0, Facing back…"，
  // iOS 给 "Back Camera" / 「背面相机」，国内内核可能给中文。
  const re = facing === 'environment'
    ? /back|rear|environment|后置|後置|背面|背向|后面/i
    : /front|user|前置|正前|前面/i;
  const pick = others.find((d) => re.test(d.label || '')) || others[0];

  try {
    const st = await navigator.mediaDevices.getUserMedia({
      video: { ...videoConstraints(null), deviceId: { exact: pick.deviceId } },
    });
    return st.getVideoTracks()[0] || null;
  } catch (e) { errs.push(e); return null; }
}

/**
 * 要一颗指定朝向的新摄像头轨道。两步走：
 *   ① facingMode: exact —— 语义最准，Android Chrome / iOS Safari 都认
 *   ② 不认就退回 deviceId，从设备列表里挑「另一颗」
 * 全失败时，抛出**信息量最大**的那个错误：优先「忙」类（它能指示调用方
 * 走「先释放再重试」），否则抛第一个。
 */
async function openCamera(facing, excludeId, excludeLabel) {
  const errs = [];
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(facing, true) });
    const t = st.getVideoTracks()[0];
    if (t) return t;
  } catch (e) { errs.push(e); }

  const t = await openOtherCamera(facing, excludeId, excludeLabel, errs);
  if (t) return t;

  throw errs.find((e) => CAM_BUSY_ERR.has(e && e.name)) || errs[0] || new Error('no other camera');
}

/**
 * 切换前置 / 后置摄像头（手机上跟微信那个「翻转」是同一件事）。
 *
 * 换轨走 `sender.replaceTrack()`：**不重新协商、不断流、画面不黑**。
 * 换完必须把旧轨道 `stop()` —— 否则摄像头指示灯会一直亮着，用户会以为
 * 被偷拍，这个信任代价付不起。
 *
 * ⚠ 手机上跟桌面上最不一样的一点：**绝大多数手机没法同时打开前后两颗
 * 摄像头**。桌面可以「先把新流拿到手，再关旧的」；手机这么干，第二次
 * `getUserMedia` 会直接 NotReadableError（资源被占），切换必然失败。
 * 所以分两阶段：
 *
 *   阶段 A：不动现有画面，直接要新轨道 —— 桌面 / 支持双开的机型走这条，
 *           全过程没有一帧黑屏。
 *   阶段 B：A 失败**且错误属于「设备忙/读不到」**时，才先把旧轨 stop() 掉、
 *           等硬件释放，再要一次；成了就换轨，还是不成 → **回滚**（把原朝向
 *           重新打开），绝不把用户丢在黑屏上。
 *
 * 单摄设备（笔记本、单摄平板）**不会**走进 B：它报的是 OverconstrainedError
 * （根本没这颗镜头）而不是「忙」，所以现有画面一点没动，直接给一句
 * 「没有另一颗摄像头」就收工 —— 不会白闪一下摄像头灯。
 */
async function flipCamera() {
  if (S.switchingCam) return;
  const next = S.facing === 'user' ? 'environment' : 'user';

  // 摄像头还没开：只记下偏好，下次开摄像头时生效。
  // 此刻也不该去采集 —— 用户没说要开视频，平白亮一下摄像头灯是冒犯。
  if (!S.camTrack) {
    S.facing = next;
    applyMirror();
    toast(next === 'environment' ? '已设为后置，下次开摄像头生效' : '已设为前置，下次开摄像头生效');
    return;
  }

  S.switchingCam = true;
  const btn = $('btn-flip');
  if (btn) btn.disabled = true;

  const prev = S.facing;
  const oldTrack = S.camTrack;
  const st0 = (oldTrack.getSettings && oldTrack.getSettings()) || {};
  const excludeId = st0.deviceId || null;
  const excludeLabel = oldTrack.label || null;

  // 提到 try 外面：中途失败时要负责把它关掉，否则新轨道悬在那儿、摄像头灯灭不了
  let track = null;
  let releasedOld = false;   // 旧轨是否已被 stop（决定失败时要不要回滚）
  S.flipLog = [];

  try {
    // ---------------- 阶段 A：不动现有画面 ----------------
    try {
      track = await openCamera(next, excludeId, excludeLabel);
    } catch (eA) {
      S.flipLog.push(`阶段A失败(${eA && eA.name}：${(eA && eA.message) || ''})`);
      if (!CAM_BUSY_ERR.has(eA && eA.name)) throw eA;

      // ---------------- 阶段 B：先释放旧摄像头，再要一次 ----------------
      S.flipLog.push('阶段B：先 stop 旧摄像头再重试');
      releasedOld = true;
      try { oldTrack.stop(); } catch { /* noop */ }
      S.camTrack = null;
      await waitMs(240);   // Android 上 stop() 到硬件真正释放有几十毫秒，太急会照样报占用
      track = await openCamera(next, excludeId, excludeLabel);
      S.flipLog.push('阶段B成功');
    }

    // ---------------- 换轨 ----------------
    const sender = videoSenderOf(S.pc);
    if (sender) await sender.replaceTrack(track);

    if (S.localStream) {
      for (const t of S.localStream.getVideoTracks()) S.localStream.removeTrack(t);
      S.localStream.addTrack(track);      // MediaStream 是活的，换来换去视频元素自动跟着走
    }
    // 阶段 B 里已经停过了；阶段 A 成功时旧轨还在跑，这里补一刀
    if (!releasedOld) { try { oldTrack.stop(); } catch { /* noop */ } }
    S.camTrack = track;
    S.facing = next;

    const lv = $('local-video');
    if (lv) {
      lv.srcObject = S.localStream;
      lv.play().catch(() => { /* 某些浏览器换轨后会暂停，补一次播放；失败也不致命 */ });
    }
    applyMirror();
    tuneVideoSender(S.pc);   // 前后置的采集分辨率/比例可能不同，码率与缩放要重算
    queueFitStage();
    toast(next === 'environment' ? '已切到后置摄像头' : '已切到前置摄像头');
  } catch (e) {
    console.warn('切换摄像头失败', e, S.flipLog);
    // 拿到手又没用上的那条轨道必须还回去 —— 否则摄像头指示灯会一直亮着
    if (track && track !== S.camTrack) { try { track.stop(); } catch { /* noop */ } }

    // 阶段 B 已经把旧摄像头关掉了：必须把它重新打开，不能把用户丢在黑屏上
    if (releasedOld && !S.camTrack) {
      try {
        const st = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(prev) });
        const back = st.getVideoTracks()[0];
        S.camTrack = back;
        const sender = videoSenderOf(S.pc);
        if (sender) await sender.replaceTrack(back);
        if (S.localStream) {
          for (const t of S.localStream.getVideoTracks()) S.localStream.removeTrack(t);
          S.localStream.addTrack(back);
        }
        const lv = $('local-video');
        if (lv) { lv.srcObject = S.localStream; lv.play().catch(() => { /* noop */ }); }
        S.media.video = true;
        syncMediaUI(); syncStage();
        S.flipLog.push('已回滚到原摄像头');
      } catch (e2) {
        console.warn('回滚也失败，视频暂时不可用', e2);
        S.media.video = false;
        syncMediaUI(); syncStage(); pushMediaState();
        S.flipLog.push(`回滚失败(${e2 && e2.name})`);
      }
    }
    toast('切换失败：' + camErrText(e));
  } finally {
    S.switchingCam = false;
    if (btn) btn.disabled = false;
    refreshCamCount();     // 换过摄像头后数量可能变（外接设备插拔），按钮要不要留跟着重算
    queueFitStage();
  }
}

/**
 * 通话中开关自己的麦克风 / 摄像头。
 *
 * ⚠ 这两颗按钮现在只长在**通话界面**里（顶栏那份已经拿掉），所以必须先确认
 * 有通话在进行。否则它们会变成「一键开麦但对面听不到」的假开关 ——
 * 一边采集一边没人接，用户只会以为产品坏了。
 */
async function toggleMic() {
  if (!inCall()) { toast('先发起通话，再调麦克风'); return; }
  if (!S.micTrack) { await ensureMic(); return; }
  S.micTrack.enabled = !S.micTrack.enabled;
  S.media.audio = S.micTrack.enabled;
  pushMediaState();
  syncMediaUI();
  syncStage();
}

async function toggleCam() {
  if (!inCall()) { toast('先发起通话，再调摄像头'); return; }
  if (S.callKind !== 'video') { toast('这次是语音通话，没有摄像头可调'); return; }
  if (!S.camTrack) { await ensureCam(); return; }
  S.camTrack.enabled = !S.camTrack.enabled;
  S.media.video = S.camTrack.enabled;
  pushMediaState();
  syncMediaUI();
  syncStage();
}

/**
 * 争取一次远端音频的播放。
 *
 * 这是「互相听不到对方声音」最常见的**真实**原因：浏览器的自动播放策略
 * 会拦掉非用户手势触发的音频 —— 视频还在动、画面一切正常，就是没声音。
 * 这时绝不能静默失败（原实现就是 `.catch(() => {})`），否则用户只会
 * 归因成「对方没开麦」或者「这产品坏了」。被拦就把解锁条亮出来。
 */
async function ensureRemotePlayback() {
  const rv = $('remote-video');
  try {
    await rv.play();
    setAudioBlocked(false);
  } catch {
    setAudioBlocked(true);
  }
}

function setAudioBlocked(on) {
  S.audioBlocked = on;
  const b = $('audio-unlock');
  if (b) b.hidden = !on;
}

/* ============================== 通话 ============================== */

/**
 * 通话态 = 有 `callKind`。
 *
 * 为什么把「通话」做成一个**显式状态**，而不是从 media 推导出来：
 *   · 通话界面该不该全屏铺开；
 *   · 输入栏该不该收起（收起 = 从界面上堵掉「通话中又去点发起通话」）；
 *   · 重连 / 对方退出这几条路径上，通话该继续还是该结束。
 * 这三件事都需要一个确定的答案，而 media 表达不了 —— 视频通话里我能把摄像头
 * 关掉继续通话（media.video=false 但还在通话里）。
 */
function inCall() { return S.callKind !== null; }

/** 视频通话里画面是不是真的在显示（双方都关了摄像头时就不显示） */
function callVideoOn() {
  return S.callKind === 'video' && (S.media.video || S.remoteMedia.video);
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function updateCallTimer() {
  const el = $('call-timer');
  if (!el) return;
  el.textContent = S.callStartedAt ? fmtClock(Date.now() - S.callStartedAt) : '';
}

function startCallTimer() {
  stopCallTimer();
  updateCallTimer();
  S.callTimer = setInterval(updateCallTimer, 1000);
}

function stopCallTimer() {
  if (S.callTimer) { clearInterval(S.callTimer); S.callTimer = null; }
}

/**
 * 进入通话（界面部分）。媒体采集由调用方负责 —— 顺序不能乱：
 * 「呼叫」时先开自己的麦（那是我的手势），「接听」时开麦发生在这一步之前。
 */
function beginCall(kind, ringing) {
  S.callKind = kind;
  S.callRinging = !!ringing;
  S.callStartedAt = 0;
  // 画面布局回默认：具体摆成什么样由 applyStageLayout 按双方有没有画面决定
  // （见那里的说明），这里只把「用户亲手点过」的痕迹清掉。
  S.stageMain = null;
  S.stagePicked = false;
  syncCallUI();
  syncStage();
  queueFitStage();
  pushMediaState();
}

/** 刷新通话界面上的文字（对方设备名 / 状态 / 时长） */
function updateCallHead() {
  const peer = $('call-peer');
  if (peer) peer.textContent = S.peerName || '对方';
  const state = $('call-state');
  if (state) {
    state.textContent = S.callRinging
      ? '正在呼叫…'
      : (S.callKind === 'video' ? '视频通话中' : '语音通话中');
  }
  const timer = $('call-timer');
  if (timer) timer.textContent = S.callRinging ? '' : (S.callStartedAt ? fmtClock(Date.now() - S.callStartedAt) : '');
}

/** 把通话状态落到 DOM 上。幂等，随便调。 */
function syncCallUI() {
  const on = inCall();
  const room = $('room');
  if (room) room.classList.toggle('call-mode', on);

  const bar = $('call-ui');
  if (bar) bar.hidden = !on;
  if (!on) return;

  // 画面真的出现时藏掉头像占位；双方都关了摄像头时它当兜底
  const audioView = $('call-audio');
  if (audioView) audioView.hidden = callVideoOn();

  // 语音通话里没有摄像头可关，「翻转」更是只对视频通话有意义
  const cam = $('btn-cam');
  if (cam) cam.hidden = S.callKind !== 'video';
  const flip = $('btn-flip');
  if (flip) flip.hidden = !(S.callKind === 'video' && S.camCount >= 2);

  updateCallHead();
}

/**
 * 结束通话（挂断）。
 *
 * @param {{silent?: boolean, note?: string}} o
 *   silent —— 不发 bye（对方先挂断 / 拒绝时，再回一条没有意义）
 *   note   —— 用哪句话告诉用户「为什么结束了」
 */
function endCall(o = {}) {
  if (!inCall()) return;
  // 先告诉对方一声，让他那边立刻收起界面，而不是干等超时
  if (!o.silent) sendCtl({ t: 'bye' });
  clearTimeout(S.callOutTimer);
  S.callOutTimer = null;
  // stopLocalMedia 会把通话态一并复位（见那里的说明）
  stopLocalMedia();
  notice(o.note || '通话已结束');
}

/** 对方挂断了 */
function onBye() {
  if (!inCall()) return;
  endCall({ silent: true, note: '对方已挂断通话' });
}

/**
 * 发起一次通话。
 *
 * 为什么是「呼叫 → 对方接听」而不是我按一下两边一起开麦：
 *   · **开麦必须由使用者自己点。** 浏览器不允许无用户手势就采集麦克风，
 *     getUserMedia 会直接被拒 —— 技术上替不了。
 *   · 这也是隐私底线：谁也不能替对面打开话筒。
 * 所以这里做两件事：我自己立刻开麦/开镜头（这是我的手势，合法）；
 * 给对方发一条 ring，他点头之后他那边的麦克风才开。
 *
 * 顺便解掉一个隐蔽的坑：对方点「接听」这个手势，同时解锁了他浏览器里
 * 远端音频的自动播放 —— 否则他会遇到「接了但听不到」。
 */
async function startCall(kind) {
  if (!connected()) { toast('还没和对方接通，请稍候'); return; }
  // 通话是互斥的。界面上输入栏已经被全屏通话界面盖住了，这里是第二道保险 ——
  // 自动化脚本、无障碍工具、以及各种边角时序都可能绕过界面。
  if (inCall()) { toast('正在通话中，请先挂断'); return; }
  if (S.ringKind) { toast('对方正在来电，请先接听或拒绝'); return; }

  const okMic = await ensureMic();
  if (!okMic) return;
  if (kind === 'video') {
    // 摄像头拿不到就别开视频通话：对面看到的会是一个「视频通话却只有一方有
    // 画面」的怪界面，不如直接把话说清楚
    const okCam = await ensureCam();
    if (!okCam) { stopLocalMedia(); return; }
  }

  // 上面两个 await 期间用户可能又点了另一颗按钮 —— 再确认一次
  if (inCall()) return;

  beginCall(kind, true);
  sendCtl({ t: 'ring', kind, name: S.myName || '' });
  notice(kind === 'video' ? '已发起视频通话，等对方接听' : '已发起语音通话，等对方接听');

  // 对方一直不接就收摊，别给发起方留一个永远不结束的呼叫
  clearTimeout(S.callOutTimer);
  S.callOutTimer = setTimeout(() => {
    if (S.callRinging) endCall({ note: '对方没有接听' });
  }, 30_000);
}

/** 收到对方的呼叫请求 → 亮出来电浮层。 */
function onRing(m) {
  const kind = m.kind === 'video' ? 'video' : 'audio';

  // 已经在通话了（两边几乎同时按下的情况）：直接回绝，
  // 否则会在通话中途弹出第二个来电浮层，把当前这通搅乱
  if (inCall()) {
    sendCtl({ t: 'ring-answer', kind, accept: false });
    notice('你正在通话中，已回绝对方这次的呼叫');
    return;
  }

  S.ringKind = kind;
  $('ring').className = 'ring' + (kind === 'video' ? ' kind-video' : '');
  $('ring-title').textContent = `对方想和你${kind === 'video' ? '视频' : '语音'}通话`;
  $('ring-sub').textContent = (m.name ? `对方设备：${m.name}\n` : '')
    + '接听后才会打开你的麦克风';
  $('ring').hidden = false;
  clearTimeout(S.ringTimer);
  S.ringTimer = setTimeout(() => {
    dismissRing();
    notice('对方发起过通话，你没接到');
  }, 30_000);
}

function dismissRing() {
  clearTimeout(S.ringTimer);
  S.ringTimer = null;
  S.ringKind = null;
  $('ring').hidden = true;
}

async function acceptRing() {
  const kind = S.ringKind;
  dismissRing();
  const ok = await ensureMic();       // ← 这次点击就是「用户手势」，顺带解锁远端音频播放
  if (!ok) { sendCtl({ t: 'ring-answer', kind, accept: false }); return; }
  if (kind === 'video') {
    // 摄像头没拿到就降级成语音接通，而不是把整通电话推掉 —— 至少还能说上话
    const okCam = await ensureCam();
    if (!okCam) toast('摄像头没打开，已按语音通话接通');
  }
  await ensureRemotePlayback();
  sendCtl({ t: 'ring-answer', kind, accept: true });
  beginCall(kind === 'video' && S.media.video ? 'video' : 'audio', false);
  S.callStartedAt = Date.now();
  startCallTimer();
  updateCallHead();
  notice('已接听');
}

function declineRing() {
  const kind = S.ringKind;
  dismissRing();
  sendCtl({ t: 'ring-answer', kind, accept: false });
  notice('已拒绝这次通话');
}

function onRingAnswer(m) {
  if (m.accept) {
    if (!inCall()) return;
    S.callRinging = false;
    S.callStartedAt = Date.now();
    startCallTimer();
    clearTimeout(S.callOutTimer);
    S.callOutTimer = null;
    updateCallHead();
    pushMediaState();      // 呼叫期间刻意没报状态，现在正式接通了补一次
    notice('对方已接听');
    toast('已接通');
    return;
  }
  // 对方拒绝：这边也收干净，否则麦克风一直开着、界面一直挂着「正在呼叫」
  if (inCall()) endCall({ silent: true, note: '对方拒绝了通话请求' });
  toast('对方拒绝了这次通话');
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
  setAudioBlocked(false);
  dismissRing();

  // 通话态与布局一并复位。**挂在 stopLocalMedia 上而不是 endCall 上**：
  // 退出房间、被请出、对方离开……这些路径都会停媒体，但都不是「挂断」。
  // 只要媒体停了，全屏通话界面就必须跟着退掉 —— 否则用户看到的是一个
  // 没有画面、也没有麦克风的通话界面，只会以为「挂不掉」。
  clearTimeout(S.callOutTimer);
  S.callOutTimer = null;
  stopCallTimer();
  S.callKind = null;
  S.callRinging = false;
  S.callStartedAt = 0;

  // 布局与摄像头偏好也复位：下一通回到默认的「对方铺满 + 前置摄像头」，
  // 就像刚接通一样 —— 上一通点过放大、翻过后置，不该带到下一通里。
  S.stageMain = null;
  S.stagePicked = false;
  S.pipHinted = false;
  S.facing = 'user';
  S.flipLog = [];
  applyMirror();
  syncCallUI();
  syncStage();
  pushMediaState();     // 让对端立刻收起界面，而不是等它自己超时
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

  // 把对端状态挂到按钮的 tooltip 上，不占界面空间
  mic.dataset.peer = S.remoteMedia.audio ? 'on' : 'off';
  cam.dataset.peer = S.remoteMedia.video ? 'on' : 'off';
  if (connected()) {
    mic.title += S.remoteMedia.audio ? '（对方麦克风开着）' : '（对方还没开麦）';
    cam.title += S.remoteMedia.video ? '（对方摄像头开着）' : '（对方还没开摄像头）';
  }

  // 输入栏的两个通话入口：通话中点亮，表示「这路已经通了」
  const callA = $('btn-call-audio');
  const callV = $('btn-call-video');
  if (callA) callA.classList.toggle('on', S.media.audio && S.remoteMedia.audio);
  if (callV) callV.classList.toggle('on', S.media.video && S.remoteMedia.video);

  // 通话界面里那排按钮（麦克风 / 摄像头 / 翻转）也跟着刷新
  syncCallUI();
}

/**
 * 视频区的显隐与文案。
 *
 * ⚠ 视频舞台**只在视频通话里出现**。语音通话用全屏的头像视图（微信语音通话
 * 就是那样），非通话状态更不该占屏幕 —— 之前那版「有音频就显示一块空舞台、
 * 里面写『语音通话中』」，在全屏通话界面里显得很将就。
 */
function syncStage() {
  const stage = $('stage');
  const lv = $('local-video');
  const showVideo = callVideoOn();

  if (!showVideo) {
    stage.hidden = true;
    stage.style.height = '';      // 收起时把内联高度清掉，别把上次的算出来
    syncCallUI();
    return;
  }
  stage.hidden = false;

  // 自己那格：没开摄像头就显示一块占位，而不是留个黑框
  lv.hidden = !S.media.video;
  const localEmpty = $('stage-empty-local');
  if (localEmpty) localEmpty.hidden = S.media.video;

  // 对方那格
  const empty = $('stage-empty');
  const remoteVideoOn = S.remoteMedia.video;
  empty.hidden = remoteVideoOn;
  if (!remoteVideoOn) {
    empty.textContent = S.remoteMedia.audio ? '对方开着麦克风，没开摄像头' : '对方还没打开摄像头';
  }

  // 角标带上设备名 + 麦克风状态。
  // 「听不到对方」有一半情况其实是对面没开麦 —— 与其让用户猜，不如直接写在画面角上。
  const tagR = $('tag-remote');
  const tagL = $('tag-local');
  if (tagR) {
    const parts = ['对方'];
    if (S.peerName) parts.push(S.peerName);
    if (connected() && !S.remoteMedia.audio) parts.push('未开麦');
    tagR.textContent = parts.join(' · ');
  }
  if (tagL) {
    const parts = ['我'];
    if (S.myName) parts.push(S.myName);
    if (!S.media.audio) parts.push('已静音');
    tagL.textContent = parts.join(' · ');
  }

  // 「点一下能放大」这个交互**没有任何视觉入口** —— 不主动说一次，没人会去试。
  // 只说一次（每通电话一次），说多了就是噪音。
  if (!S.pipHinted && S.media.video && S.remoteMedia.video) {
    S.pipHinted = true;
    notice('点小窗可以把自己那格换到大的位置，再点对方那格就换回来');
  }

  syncCallUI();
  applyStageLayout();
}

/* ---------------------------- 视频区：等分 / 放大 ---------------------------- */

/**
 * 点某一格 = 把那一格放大、另一格缩成右上角小窗。
 *
 * 视频通话的**初始态就是**「对方铺满 + 我右上角小窗」（见 applyStageLayout），
 * 这里管的是用户点过之后怎么切：点哪格哪格变大，点已经大的那格不动。
 * 不做自动来回切 —— 画面自己跳来跳去比一直大着更烦人。
 */
function setStageMain(slot) {
  // 点的那格必须真的有画面：把一块「对方还没打开摄像头」的占位放大毫无意义
  if (slot === 'local' && !S.media.video) return;
  if (slot === 'remote' && !S.remoteMedia.video) return;
  if (S.stageMain === slot) return;      // 已经是大的了，再点不做事
  S.stageMain = slot;
  S.stagePicked = true;                  // 从此不再自动摆位（否则用户刚点完就被改回去）
  applyStageLayout();
}

/** 把 S.stageMain 落到 DOM 上（.pip + 哪一格 .small），并重算高度。 */
function applyStageLayout() {
  const stage = $('stage');
  if (!stage) return;

  if (S.callKind === 'video') {
    const R = !!S.remoteMedia.video;
    const L = !!S.media.video;
    if (!S.stagePicked) {
      // 没被用户点过 → 自动摆成微信那个样子：**对方铺满，自己右上角小窗**。
      // 对方画面还没到的这一小段先看自己：给一块「对方还没打开摄像头」的大占位
      // 比什么都难受，而这时候用户最想确认的恰恰是「我这边出画了吗」。
      // 对方的画面一到（remoteMedia.video 转 true）就自动让位给他。
      S.stageMain = R ? 'remote' : (L ? 'local' : 'remote');
    } else if (S.stageMain && !(S.stageMain === 'local' ? L : R)) {
      // 用户选中的那格对面关了摄像头 → 让给还有画面的另一格
      const other = S.stageMain === 'local' ? 'remote' : 'local';
      if (other === 'local' ? L : R) S.stageMain = other;
    }
  }

  const pip = !!S.stageMain;
  stage.classList.toggle('pip', pip);
  const paneR = $('pane-remote');
  const paneL = $('pane-local');
  if (paneR) paneR.classList.toggle('small', pip && S.stageMain !== 'remote');
  if (paneL) paneL.classList.toggle('small', pip && S.stageMain !== 'local');

  fitStage();
}

/**
 * 让视频区的高度**贴着实际画面比例**走。
 *
 * CSS 里给的是「按摄像头大概长宽比倒推」的经验值（竖屏 3:4 / 横屏 16:9），
 * 但真实摄像头什么比例都有 —— 4:3、16:9、甚至 9:16 竖屏。
 * 用 object-fit: contain 不裁切是对的，但如果格子比例和画面差太多，
 * 就会留出很宽的黑边，看着像「没铺满」。
 *
 * 所以拿到真实分辨率后重算一次格子高度：等分时格宽 = (舞台宽 - 间隙) / 2，
 * 放大时格宽就是整个舞台宽；高度 = 格宽 / 画面比例。这样 contain 几乎不留黑边，
 * 同时**两块格子依然等大**。
 *
 * 优先用对方画面的比例 —— 屏幕上主要看的是对方。
 * 上限压到视口高度的 62%，免得一块竖屏画面把聊天区整个吃掉。
 */
function fitStage() {
  const stage = $('stage');
  if (!stage || stage.hidden) return;

  // 全屏通话态：高度只由视口决定（CSS 里写了 inset: 0），
  // 不该再按摄像头比例去算 —— 那样反而会把铺满的舞台压成一条。
  if (S.callKind) { stage.style.height = ''; return; }

  const ratioOf = (v) => (v && v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 0);
  // 对方还没出画面时，用自己摄像头的比例兜底（通常两台设备的摄像头是同类）
  const ratio = ratioOf($('remote-video')) || ratioOf($('local-video'));
  if (!ratio) { stage.style.height = ''; return; }   // 回落到 CSS 的默认高度

  // 放大模式只有一格，等分模式两格；间隙 2px 与 CSS 里 .stage 的 gap 保持一致
  const cols = S.stageMain ? 1 : 2;
  const paneW = Math.max(0, (stage.clientWidth - (cols - 1) * 2) / cols);
  if (!paneW) return;
  const h = Math.round(Math.max(110, Math.min(paneW / ratio, window.innerHeight * 0.62)));
  // 读 clientWidth 会强制一次同步布局，所以只在高度真的变了时才写回去 ——
  // 反复写同一个值等于白白触发重排
  const next = h + 'px';
  if (stage.style.height !== next) stage.style.height = next;
}

/*
 * resize 是**高频**事件：拖动窗口时每个像素都会触发一次，手机地址栏收放同理。
 * 而 fitStage 要读 clientWidth（强制同步布局）再写 height（触发重排），
 * 直接把它挂在 resize 上就是一路卡着主线程抖。合并到下一帧，一帧最多算一次。
 */
let fitQueued = false;
function queueFitStage() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitStage(); });
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
  get myName() { return S.myName; },
  get peerName() { return S.peerName; },
  get metaSelf() { return $('meta-self').textContent; },
  get metaOther() { return $('meta-other').textContent; },
  get autoKick() { return S.autoKick; },
  get autokickShown() { return !$('autokick-wrap').hidden; },
  get blockedCount() { return getBlocked(S.room).length; },
  get isHost() { return S.isHost; },
  get kickBtnShown() { return !$('trust-kick').hidden; },
  get trustShown() { return !$('trust').hidden; },
  get trustClass() { return $('trust').className; },
  get trustText() { return $('trust-text').textContent; },
  get trustKeepShown() { return !$('trust-keep').hidden; },
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
    // 只挑文本气泡：语音/文件也是 .msg，但它们没有 text 语义，
    // 混进来会把「聊了什么」这件事搅浑
    return [...document.querySelectorAll('#log .msg.text')]
      .map((e) => ({ who: e.classList.contains('me') ? 'me' : 'them', text: e.textContent }));
  },
  get voiceCount() { return document.querySelectorAll('#log .msg.voice').length; },
  get fileCount() { return document.querySelectorAll('#log .msg.file').length; },
  get txCount() { return S.txCount; },
  get rxCount() { return S.rxCount; },
  get voiceMode() { return S.voiceMode; },
  get audioBlocked() { return S.audioBlocked; },
  get audioUnlockShown() { return !$('audio-unlock').hidden; },
  get ringShown() { return !$('ring').hidden; },
  get stageShown() { return !$('stage').hidden; },

  /* ---- 通话态（排障与自动化测试用）---- */
  get callKind() { return S.callKind; },
  get inCall() { return inCall(); },
  get callRinging() { return S.callRinging; },
  get callUiShown() { return !$('call-ui').hidden; },
  get callMode() { return $('room').classList.contains('call-mode'); },
  get callTimerText() { return $('call-timer').textContent; },
  get callPeerText() { return $('call-peer').textContent; },
  get callStateText() { return $('call-state').textContent; },
  /**
   * 此刻「对方信令断开」会等多久才宣布他真的走了（毫秒）。
   * 通话中必须给足（20 秒）—— 线上重连远比 1.5 秒慢，短了会把正在进行的通话误杀。
   * 把它暴露出来是因为这个 bug **本地永远复现不了**（wrangler dev 同进程重连只要
   * 几十毫秒），只能靠断言「宽限期本身够不够长」来钉住。
   */
  get peerLeftGrace() { return inCall() ? PEER_LEFT_GRACE_CALL : PEER_LEFT_GRACE; },
  /** 通话全屏时输入栏应当被收起 —— 这正是「不能再点发起通话」的界面保证 */
  get composerHidden() { return getComputedStyle($('composer')).display === 'none'; },
  /** 「按住说话」那颗按钮的实际尺寸（验证它真的是个放大的圆） */
  get holdTalkBox() {
    const el = $('hold-talk');
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             radius: getComputedStyle(el).borderRadius };
  },
  get localTag() { return $('tag-local').textContent; },
  get remoteTag() { return $('tag-remote').textContent; },
  get facing() { return S.facing; },
  get camCount() { return S.camCount; },
  get flipShown() { return !$('btn-flip').hidden; },
  /** 最近一次「切换前后摄像头」的步骤轨迹 —— 手机上出问题时报这个最快 */
  get flipLog() { return S.flipLog.slice(); },
  /** 手动触发一次切换（等价于点按钮） */
  flip() { flipCamera(); return true; },
  /** 重新数一遍摄像头数量（用户去系统设置改过权限后，不用刷新页面） */
  refreshCams() { refreshCamCount(); },
  get stageMain() { return S.stageMain; },
  /** 用户是否亲手点过某一格 —— 点过之后程序不再自动改布局，直到这通电话结束 */
  get stagePicked() { return S.stagePicked; },
  get stagePip() { return $('stage').classList.contains('pip'); },
  get smallPane() {
    return [...document.querySelectorAll('#stage .pane.small')].map((p) => p.dataset.slot);
  },
  get selfTestLinks() {
    return [...document.querySelectorAll('.selftest a')].map((a) => ({ href: a.href, target: a.target, rel: a.rel }));
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
    // 改成「已确认」而不是把提示条收掉：用户刚做完一个决定，界面得给个回执，
    // 否则会怀疑自己是不是点空了
    showTrust('ok', '已确认为熟悉的设备');
    toast('已把这台设备记为对方');
  });
  $('trust-kick').addEventListener('click', () => kickPeer());

  // 房主专属：自动请出开关 + 解除拉黑。
  // 这两个控件存在的唯一理由，是让「误把对方请出去」这件事**有回头路**：
  // 开关关掉后拉黑名单不再生效，解除按钮则把名单整个清掉。
  S.autoKick = loadAutoKick();
  $('autokick').checked = S.autoKick;
  $('autokick').addEventListener('change', () => {
    S.autoKick = $('autokick').checked;
    saveAutoKick(S.autoKick);
    toast(S.autoKick
      ? '已开启「自动请出」：拉黑过的设备再进来自动请走'
      : '已关闭「自动请出」：拉黑过的设备再进来只提示，由你决定');
  });
  $('btn-unblock').addEventListener('click', () => {
    const n = getBlocked(S.room).length;
    clearBlocked(S.room);
    reflectHostUI();
    toast(n ? `已解除对 ${n} 台设备的拉黑，它们可以正常进来了` : '名单本来就是空的');
  });

  // 机型属于高熵字段，只能异步补 —— 见 refineDeviceName 里的说明
  refineDeviceName();

  $('composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('text');
    const text = input.value.trim();
    if (!text) return;
    if (sendText(text)) input.value = '';
    else toast('还没和对方接通，请稍候');
  });

  /* ---- 输入栏：语音 / 附件 / 发起通话 ---- */

  $('btn-voice').addEventListener('click', () => setVoiceMode(!S.voiceMode));

  // 按住说话：pointerdown 起录、pointerup 停。
  // pointerup/pointercancel 挂在 window 而不是按钮上 —— 手指按住后划出按钮范围
  // 再松开时，按钮收不到 pointerup，录音就会一直挂着。
  const hold = $('hold-talk');
  const holdLabel = $('hold-label');
  const setHoldLabel = (t) => { if (holdLabel) holdLabel.textContent = t; };
  let holdWanted = false;   // 手指还按着吗

  // 长按弹系统菜单（iOS 会选中文字、Android 会弹「复制链接」）会打断按住不放，
  // 这是「按不住」最常见的另一半原因
  hold.addEventListener('contextmenu', (ev) => ev.preventDefault());

  hold.addEventListener('pointerdown', async (ev) => {
    ev.preventDefault();
    if (holdWanted) return;
    holdWanted = true;
    hold.classList.add('recording');
    setHoldLabel('松开');

    await startRecord();     // 申请麦克风是异步的，这期间用户可能已经松手了

    if (!S.recorder) {       // 起录失败（没权限 / 不支持）
      holdWanted = false;
      hold.classList.remove('recording');
      setHoldLabel('按住');
      return;
    }
    // 松手发生在麦克风就绪之前 → 这条本来就没打算录，直接丢弃。
    // 不处理的话，录音会一直挂到 60 秒上限才停，用户会觉得「按一下就开始偷录」。
    if (!holdWanted) {
      stopRecord(true);
      hold.classList.remove('recording');
      setHoldLabel('按住');
    }
  });

  const endHold = () => {
    holdWanted = false;
    if (!S.recorder) return;
    hold.classList.remove('recording');
    setHoldLabel('按住');
    stopRecord();
  };
  window.addEventListener('pointerup', endHold);
  window.addEventListener('pointercancel', () => {
    holdWanted = false;
    if (!S.recorder) return;
    hold.classList.remove('recording');
    setHoldLabel('按住');
    stopRecord(true);
  });

  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (ev) => {
    const files = [...ev.target.files];   // 先拷出来：清空 input 会让 FileList 一起失效
    ev.target.value = '';
    sendFiles(files);
  });

  $('btn-call-audio').addEventListener('click', () => startCall('audio'));
  $('btn-call-video').addEventListener('click', () => startCall('video'));

  /* ---- 来电浮层 ---- */
  $('ring-accept').addEventListener('click', acceptRing);
  $('ring-decline').addEventListener('click', declineRing);

  /* ---- 远端声音解锁 ---- */
  $('audio-unlock').addEventListener('click', async () => {
    try { await $('remote-video').play(); setAudioBlocked(false); }
    catch { toast('还是被拦住了：请检查系统音量 / 静音开关'); }
  });

  $('btn-mic').addEventListener('click', toggleMic);
  $('btn-cam').addEventListener('click', toggleCam);
  $('btn-flip').addEventListener('click', flipCamera);
  // 挂断：只结束通话，人还留在房间里（要离开房间是顶栏那个 ✕）
  $('btn-hangup-call').addEventListener('click', () => endCall());

  // 视频区：点哪一格，哪一格放大（另一格缩成小窗）。键盘 Enter / 空格同样可用 ——
  // 这两格是 role="button"，不让键盘用户点得动就是假的按钮。
  for (const slot of ['remote', 'local']) {
    const pane = $('pane-' + slot);
    pane.addEventListener('click', () => setStageMain(slot));
    pane.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        setStageMain(slot);
      }
    });
  }

  // 外接摄像头插拔时按钮该出现 / 消失
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshCamCount);
  }
  // 有些浏览器还没授权也能列出设备数量，先问一次；拿不到就等 ensureCam 成功后再问
  refreshCamCount();

  // 画面分辨率一出来（或旋转屏幕、改窗口大小）就重算视频区高度 —— 见 fitStage。
  // 统一走 queueFitStage：这几个事件全是高频的，合并到帧上再算，别让布局抖成筛子。
  for (const id of ['remote-video', 'local-video']) {
    const v = $(id);
    v.addEventListener('loadedmetadata', queueFitStage);
    v.addEventListener('resize', queueFitStage);
  }
  window.addEventListener('resize', queueFitStage);
  window.addEventListener('orientationchange', () => setTimeout(queueFitStage, 120));

  // 画质档位：存在本机，下次打开还是这个选择
  loadQuality();
  const qSel = $('video-quality');
  qSel.value = currentQuality();
  qSel.addEventListener('change', onQualityChange);

  $('btn-hangup').addEventListener('click', () => {
    // 通话中主动退房 = 「确定要走」，要先把这一通挂掉（发 bye），让对端**立刻**
    // 收掉摄像头 —— 而不是干等 peer-left 的宽限期。通话态那个宽限期是专门留给
    // 「网络抖动、等着重连」的（20 秒），拿它来延迟「对方主动离开」毫无道理，
    // 对方会对着一个已经空了的房间干瞪 20 秒。
    if (inCall()) endCall();
    // 再告诉对方一声，让他那边立刻收到 peer-left 而不是等超时
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

  // 任何一次点击都顺手争取一次播放权：用户点界面时就把可能被拦住的远端音频放出来，
  // 免得他非要找到那条解锁提示才听得见。
  document.addEventListener('pointerdown', () => {
    if (!S.audioBlocked) return;
    $('remote-video').play().then(() => setAudioBlocked(false)).catch(() => { /* noop */ });
  }, { passive: true });

  // 刷新后自动回到同一间房：房间号存在 sessionStorage 里，
  // 关掉标签页就没了 —— 想「用完即走」的时候它不会留下任何东西。
  const saved = sessionStorage.getItem('rt.room');
  if (saved && /^[0-9a-f]{32}$/.test(saved)) {
    enterRoom(saved);
  } else {
    $('passphrase').focus();
  }

  setVoiceMode(false);
  syncMediaUI();
  syncStage();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
