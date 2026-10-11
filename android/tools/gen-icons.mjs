/**
 * 生成 Android 启动图标（各密度 PNG + 自适应图标的前景 PNG）。
 * ---------------------------------------------------------------------------
 * 图案是白色的「8.中国」大字，底色沿用 #2f6df6（与网站 favicon 同一个蓝）。
 *
 * 为什么用无头 Chrome 而不是画图库：本机没有 Pillow / sharp，而要让中文字形
 * 正确成型就必须有字体引擎。直接让浏览器渲染，字形和排版问题一次性解决，
 * 也不用引入任何图形库依赖。
 *
 * ⚠ 不能用 `chrome --headless --screenshot=...`：这一份便携版 Chrome（153）
 *   会把截图请求交给已存在的实例、自己立刻以 0 退出，**一个文件都不写、还不报错**。
 *   所以走 CDP（和 test/e2e.mjs 同一条路），由我们自己拿 base64 落盘。
 *
 * ⚠ 字号不是拍脑袋定的：先在页面里用 getBBox() 量出文字的真实外框，再反算
 *   缩放 —— 中文字形的高度和西文数字差很多，写死 font-size 一定会一边溢出、
 *   一边留白。这一点在自适应图标上更要命（见下）。
 *
 * 用法： node android/tools/gen-icons.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 系统代理会劫持 127.0.0.1，把环境变量摘干净（同 e2e）
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
const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, '..', 'app', 'src', 'main', 'res');
const WORK = join(HERE, '.icon-work');
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 设计参数 ------------------------------ */

/** 底色的唯一出处 —— 必须与 values/colors.xml 的 ic_launcher_background 一致 */
const BRAND = '#2f6df6';
const TEXT = '8.中国';

/* 画布统一 108×108 视口（自适应图标的标准尺寸，legacy 图也按同一视口缩下去，
   这样两套图的视觉重量是一致的，不用分别为它们调字号）。 */
const VIEW = 108;

/*
 * 自适应图标（API 26+）的坑：系统会给图标套一个**只保证中间 72dp 可见**的遮罩，
 * 外面那一圈随时可能被裁掉（圆形、方形、水滴形都可能）。所以前景不能铺满 108，
 * 得缩进安全区里。外接矩形 62×26 正好能被 72 直径的圆装下：
 *   (62/2)² + (26/2)² = 961 + 169 = 1130 ≤ 36² = 1296 ✓
 */
const SAFE_W = 62;
const SAFE_H = 26;

/* legacy 图标只有两种版式；字号上限在下面 fitText() 里按版式分别算，
   中文字形的高度和西文数字差很多，写死 font-size 一定会一边溢出、一边留白。 */
const VARIANTS = [
  { file: 'ic_launcher', bg: 'roundRect' },       // 方形：老系统（API 24/25）直接用这张
  { file: 'ic_launcher_round', bg: 'circle' },    // 圆形：内容和圆底一起出，字要退进圆里
];

/** legacy 图标：48dp 基准（就是 mipmap 的常规密度） */
const LEGACY_DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

/** 自适应前景：108dp 基准 */
const FG_DENSITIES = [
  ['mdpi', 108],
  ['hdpi', 162],
  ['xhdpi', 216],
  ['xxhdpi', 324],
  ['xxxhdpi', 432],
];

/** 中文优先的字体栈。取不到就退系统默认，字形不会缺，最多是字重差一点。 */
const FONT = `"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","SimHei",sans-serif`;

/* ------------------------------ CDP 客户端 ------------------------------ */

async function findWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端口没起来');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('无法连接 CDP'));
    });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面里报错了');
    return r.result && r.result.value;
  }
}

/* --------------------------------- 主流程 -------------------------------- */

/* ⚠ 这里刻意**不做** rmSync 清理 work 目录：
   本机把 fs.rmSync 劫持到回收站工具上，递归删除会 ETIMEDOUT 直接抛错；
   改成「每次换一个唯一 profile 目录」，跑多少次都不会互相干扰，也不删任何东西。 */
const PROFILE = join(WORK, 'profile-' + Date.now());
mkdirSync(WORK, { recursive: true });
mkdirSync(PROFILE, { recursive: true });

const proc = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: 'ignore' });

let cdp;
try {
  cdp = await Cdp.connect(await findWsUrl(PORT));
  await cdp.send('Page.enable');
  // 关掉默认白底，否则圆角外与圆形外会被刷成白方块
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });

  /** 渲染一段 SVG 并截成 PNG。 */
  async function shoot(svgInner, size, outPath) {
    const htmlPath = join(WORK, `shot-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEW} ${VIEW}">${svgInner}</svg>
`, 'utf8');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('document.readyState') === 'complete') break;
      await sleep(50);
    }
    await sleep(60);   // 给渲染管线一帧的时间

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  }

  /**
   * 量出文字的真实外框，反算「缩放 + 平移」，让它在视口里既占满上限、又正好居中。
   *
   * ⚠ 必须先量后画，不能边画边量：`getBBox()` 给的是**未变换**的本地坐标，
   *   在同一页上量两次会把上一次的缩放乘进去，越缩越小。
   *   而且视口固定是 108×108，与输出像素无关 —— 所以每个变体**只量一次**就够，
   *   各密度复用同一个 transform，不会出现「小图上字大、大图上字小」。
   */
  async function fitText(maxW, maxH) {
    await shoot(`<text id="t" x="0" y="0" font-family='${FONT}' font-weight="900"
      font-size="48" letter-spacing="0">${TEXT}</text>`, 216, join(WORK, 'probe.png'));

    const b = await cdp.eval(`(() => {
      const t = document.getElementById('t');
      const r = t.getBBox();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    if (!b || !(b.w > 0) || !(b.h > 0)) throw new Error('量不到文字外框（字体没加载？）');

    const s = Math.min(maxW / b.w, maxH / b.h);
    const tx = VIEW / 2 - (b.x + b.w / 2) * s;
    const ty = VIEW / 2 - (b.y + b.h / 2) * s;
    return {
      attr: `transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(4)})"`,
      w: b.w * s,
      h: b.h * s,
    };
  }

  function textEl(color, transform) {
    return `<text id="t" x="0" y="0" ${transform} fill="${color}" font-family='${FONT}'
      font-weight="900" font-size="48" letter-spacing="0">${TEXT}</text>`;
  }

  /* ---------- ① 先算出三种版式各自该用多大的字 ---------- */
  const fitLegacy = await fitText(84, 40);   // 方形 legacy：边角有圆角，四边留够
  const fitRound = await fitText(74, 34);    // 圆形 legacy：字要退进圆里
  const fitFg = await fitText(SAFE_W, SAFE_H); // 自适应前景：必须落在 72dp 安全圆内

  const reportLines = [
    `方形 legacy : ${fitLegacy.w.toFixed(1)}×${fitLegacy.h.toFixed(1)}`,
    `圆形 legacy : ${fitRound.w.toFixed(1)}×${fitRound.h.toFixed(1)}`,
    `自适应前景  : ${fitFg.w.toFixed(1)}×${fitFg.h.toFixed(1)}（安全区 ${SAFE_W}×${SAFE_H}）`,
  ];

  /* ---------- ② legacy 图标（方形 + 圆形），各密度一张 ---------- */
  let n = 0;
  for (const v of VARIANTS) {
    const fit = v.bg === 'circle' ? fitRound : fitLegacy;
    const bg = v.bg === 'circle'
      ? `<circle cx="54" cy="54" r="54" fill="${BRAND}"/>`
      : `<rect width="108" height="108" rx="24" fill="${BRAND}"/>`;

    for (const [density, size] of LEGACY_DENSITIES) {
      const dir = join(RES, `mipmap-${density}`);
      mkdirSync(dir, { recursive: true });
      await shoot(bg + textEl('#FFFFFF', fit.attr), size, join(dir, `${v.file}.png`));
      n++;
    }
  }

  /* ---------- ③ 自适应图标的前景（透明底，只有白字） ----------
   * 这里刻意输出**位图**而不是矢量：矢量里没法直接写字，要写字就得先把字形
   * 转成 path，那就得引一个字体描边提取器。位图在自适应图标里是完全合法的
   * 前景类型（系统按密度取对应那一张），省掉一整条工具链。
   */
  for (const [density, size] of FG_DENSITIES) {
    const dir = join(RES, `drawable-${density}`);
    mkdirSync(dir, { recursive: true });
    await shoot(textEl('#FFFFFF', fitFg.attr), size, join(dir, 'ic_launcher_foreground.png'));
    n++;
  }

  /* ---------- ④ 清掉旧的矢量前景 ----------
     同名资源不能同时存在于 drawable/ 与 drawable-<density>/：AGP 会当成
     重复资源报错。旧的图形（语泡 + 圆圈）也不再需要了。 */
  const oldVector = join(RES, 'drawable', 'ic_launcher_foreground.xml');
  if (existsSync(oldVector)) {
    rmSync(oldVector);
    reportLines.push('已删除旧矢量前景 drawable/ic_launcher_foreground.xml');
  }

  /* ---------- ⑤ 自适应图标的 XML（引用没变，只是前景换成了位图） ---------- */
  const anydpi = join(RES, 'mipmap-anydpi-v26');
  mkdirSync(anydpi, { recursive: true });
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    writeFileSync(join(anydpi, `${name}.xml`), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`, 'utf8');
  }

  /* ---------- ⑥ 人眼复核图：启动器实际会把它裁成什么样 ----------
   * 自适应图标的遮罩是**系统**套的（圆、方、水滴……各家不同），我们在代码里
   * 看不到最终效果。所以把「圆形遮罩 / 方形遮罩 / 老系统的两张」并排画出来，
   * 落在 docs/ 下给人看一眼 —— 和 docs/shot-call-*.png 一样，只作复核、不参与断言。
   *
   * ⚠ 这张图最该看的是「自适应那两格的字比老系统那两格小一圈」—— 那是安全区
   *   的代价，不是 bug。用 84 的宽度去填满 108，圆形遮罩会直接把「8」和「国」切掉。
   */
  const TILE = 132;
  const GAP = 18;
  const W = GAP + 4 * (TILE + GAP);
  const H = TILE + 2 * GAP + 30;
  const scale = TILE / VIEW;

  function tile(i, shape, fit, label) {
    const x = GAP + i * (TILE + GAP);
    const bg = shape === 'circle'
      ? `<circle cx="54" cy="54" r="54" fill="${BRAND}"/>`
      : `<rect width="108" height="108" rx="24" fill="${BRAND}"/>`;
    return `<g transform="translate(${x} ${GAP}) scale(${scale})">
      ${bg}${textEl('#FFFFFF', fit.attr)}
    </g>
    <text x="${x + TILE / 2}" y="${GAP + TILE + 20}" fill="#8a93a5" font-size="13"
      font-family='${FONT}' text-anchor="middle">${label}</text>`;
  }

  const preview = [
    tile(0, 'circle', fitFg, '圆形遮罩（多数启动器）'),
    tile(1, 'squircle', fitFg, '方形遮罩'),
    tile(2, 'squircle', fitLegacy, '老系统方形（API 24/25）'),
    tile(3, 'circle', fitRound, '老系统圆形'),
  ].join('');

  const docsDir = join(HERE, '..', '..', 'docs');
  mkdirSync(docsDir, { recursive: true });
  const previewPath = join(docsDir, 'icon-preview.png');
  {
    const htmlPath = join(WORK, `preview-${Date.now()}.html`);
    writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#101114;overflow:hidden}svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${preview}</svg>
`, 'utf8');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 2, mobile: false,
    });
    await cdp.send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('document.readyState') === 'complete') break;
      await sleep(50);
    }
    await sleep(80);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(previewPath, Buffer.from(shot.data, 'base64'));
    reportLines.push(`复核图：docs/icon-preview.png`);
  }

  console.log(`已生成 ${n} 张 PNG —— 内容「${TEXT}」，底色 ${BRAND}`);
  for (const line of reportLines) console.log('  ' + line);
} finally {
  // Chrome 是「启动器即退」，不能用 proc.kill()，得走 CDP 关
  try { await cdp?.send('Browser.close'); } catch { /* noop */ }
  await sleep(300);
  try { proc.kill(); } catch { /* noop */ }
}
