/**
 * 生成 Android 启动图标（各密度 PNG + 自适应图标的前景矢量）。
 * ---------------------------------------------------------------------------
 * 为什么用无头 Chrome 而不是画图库：网站的 favicon 就是一段内联 SVG，直接用
 * 浏览器把它渲成 PNG，图形与网站**逐像素一致**，也不用引入任何图形库依赖
 * （本机没有 Pillow / sharp）。
 *
 * ⚠ 不能用 `chrome --headless --screenshot=...`：这一份便携版 Chrome（153）
 *   会把截图请求交给已存在的实例、自己立刻以 0 退出，**一个文件都不写、还不报错**。
 *   所以走 CDP（和 test/e2e.mjs 同一条路），由我们自己拿 base64 落盘。
 *
 * 用法： node android/tools/gen-icons.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 系统代理会劫持 127.0.0.1，把环境变量摘干净（同 e2e）
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const CHROME = process.env.CHROME || 'E:/softs/Chrome153_AllNew_2026.9.12/App/chrome.exe';
const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, '..', 'app', 'src', 'main', 'res');
const WORK = join(HERE, '.icon-work');
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 与网站 favicon 完全相同的图形（语泡 + 圆圈带短柄），白描边、蓝底 */
const GLYPH = `
    <path d="M20 26a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H28l-6 5v-5a2 2 0 0 1-2-2z" fill="#fff"/>
    <circle cx="43" cy="24" r="7" fill="none" stroke="#fff" stroke-width="3.4"/>
    <path d="M43 31v6" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>`;

const VARIANTS = {
  // 方形：与 favicon 一模一样
  ic_launcher: `<rect width="64" height="64" rx="14" fill="#2f6df6"/>${GLYPH}`,
  // 圆形：图形重心在 (35, 29.5)，圆底中心是 (32, 32)，平移回正中心
  ic_launcher_round:
    `<circle cx="32" cy="32" r="32" fill="#2f6df6"/><g transform="translate(-3 2.5)">${GLYPH}</g>`,
};

const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

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
}

/* --------------------------------- 主流程 -------------------------------- */

/* ⚠ 这里刻意**不做** rmSync 清理：
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

  let n = 0;
  for (const [density, size] of DENSITIES) {
    const dir = join(RES, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    });

    for (const [name, inner] of Object.entries(VARIANTS)) {
      const htmlPath = join(WORK, `${name}-${size}.html`);
      writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${inner}</svg>
`, 'utf8');

      await cdp.send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
      // 内联 SVG 没有外部资源，等 readyState 就够了；不用事件是为了少一套监听
      for (let i = 0; i < 40; i++) {
        const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState' });
        if (r.result && r.result.value === 'complete') break;
        await sleep(50);
      }
      await sleep(60);   // 给渲染管线一帧的时间

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
      n++;
    }
  }

  /* 自适应图标（API 26+）的前景矢量。
     108dp 画布里只有中间 72dp 是安全区，图形按 1.6 倍放大并居中：
     原重心 (35, 29.5) → (54, 54)。下面是逐点换算后的坐标，不是拍脑袋写的。 */
  const FG = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M30 48.4a3.2 3.2 0 0 1 3.2-3.2h22.4a3.2 3.2 0 0 1 3.2 3.2v14.4a3.2 3.2 0 0 1-3.2 3.2H42.8l-9.6 8v-8a3.2 3.2 0 0 1-3.2-3.2z" />
    <path
        android:strokeColor="#FFFFFF"
        android:strokeWidth="5.44"
        android:pathData="M66.8 45.2m-11.2 0a11.2 11.2 0 1 0 22.4 0a11.2 11.2 0 1 0-22.4 0" />
    <path
        android:strokeColor="#FFFFFF"
        android:strokeWidth="5.44"
        android:strokeLineCap="round"
        android:pathData="M66.8 56.4v9.6" />
</vector>
`;
  mkdirSync(join(RES, 'drawable'), { recursive: true });
  writeFileSync(join(RES, 'drawable', 'ic_launcher_foreground.xml'), FG, 'utf8');

  const anydpi = join(RES, 'mipmap-anydpi-v26');
  mkdirSync(anydpi, { recursive: true });
  for (const name of Object.keys(VARIANTS)) {
    writeFileSync(join(anydpi, `${name}.xml`), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`, 'utf8');
  }

  console.log(`已生成 ${n} 个 PNG + 自适应图标矢量`);
} finally {
  // Chrome 是「启动器即退」，不能用 proc.kill()，得走 CDP 关
  try { await cdp?.send('Browser.close'); } catch { /* noop */ }
  await sleep(300);
  try { proc.kill(); } catch { /* noop */ }
}
