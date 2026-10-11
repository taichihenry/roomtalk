/**
 * 生成网站侧的 PWA / iOS 图标 PNG。
 * ---------------------------------------------------------------------------
 * 和 android/tools/gen-icons.mjs 同一套路：用无头 Chrome + CDP 把 favicon 那段
 * 内联 SVG 渲成 PNG，图形与网站逐像素一致，也不引入任何图形库依赖。
 *
 * 产出（都在 public/ 下，会被当成静态资源直接发布）：
 *   icon-192.png          清单里的 192（圆角方）
 *   icon-512.png          清单里的 512（圆角方）
 *   apple-touch-icon.png  iOS「添加到主屏幕」用。⚠ **不带圆角、不带透明** ——
 *                         iOS 会自己裁圆角，而透明区域会被合成到黑底上，
 *                         所以我们给一张铺满的蓝底方图。
 *
 * ⚠ 不能用 `chrome --headless --screenshot=`：这一份便携版 Chrome（153）会把
 *   截图请求交给已存在的实例、自己以 0 退出，一个文件都不写也不报错。
 *
 * 用法： node tools/gen-web-icons.mjs
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
const OUT = join(HERE, '..', 'public');
const WORK = join(HERE, '.webicon-work');
const PORT = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 与网站 favicon 完全相同的图形（语泡 + 圆圈带短柄） */
const GLYPH = `
    <path d="M20 26a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H28l-6 5v-5a2 2 0 0 1-2-2z" fill="#fff"/>
    <circle cx="43" cy="24" r="7" fill="none" stroke="#fff" stroke-width="3.4"/>
    <path d="M43 31v6" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>`;

/** 圆角方（清单用）/ 铺满方（iOS 用，自己不带圆角也不透明） */
const rounded = `<rect width="64" height="64" rx="14" fill="#2f6df6"/>${GLYPH}`;
const fullBleed = `<rect width="64" height="64" fill="#2f6df6"/>${GLYPH}`;

const TARGETS = [
  { file: 'icon-192.png', size: 192, svg: rounded },
  { file: 'icon-512.png', size: 512, svg: rounded },
  // maskable 会被系统按圆形/水滴形裁切，圆角图标露出的透明区域会被合成成难看的
  // 色块，所以这一张必须用**铺满**版（图形本身已在安全区内，裁不掉）
  { file: 'icon-maskable-512.png', size: 512, svg: fullBleed },
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleed },
];

/* ------------------------------ CDP 客户端 ------------------------------ */

async function findWsUrl(port) {
  // 首次冷启动（全新 profile 要建一整套目录）实测可能超过 15 秒，
  // 所以给到 40 秒 —— 宁可多等，也别在「差一点就起来了」的时候报错退出。
  for (let i = 0; i < 160; i++) {
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

/* ⚠ 刻意不做 rmSync 清理：本机把 fs.rmSync 劫持到回收站工具上，递归删除会
   ETIMEDOUT 抛错。换成「每次用唯一 profile 目录」，不删任何东西也不会互相干扰。 */
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

  for (const { file, size, svg } of TARGETS) {
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
      // 清单图标允许透明（圆角外），iOS 那张铺满不需要透明也无妨
      color: file.startsWith('apple') ? { r: 47, g: 109, b: 246, a: 1 } : { r: 0, g: 0, b: 0, a: 0 },
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    });

    const htmlPath = join(WORK, `${file}.html`);
    writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${svg}</svg>
`, 'utf8');

    await cdp.send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
    for (let i = 0; i < 40; i++) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState' });
      if (r.result && r.result.value === 'complete') break;
      await sleep(50);
    }
    await sleep(60);   // 给渲染管线一帧的时间

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, file), Buffer.from(shot.data, 'base64'));
    console.log(`已生成 public/${file}（${size}×${size}）`);
  }
} finally {
  // Chrome 是「启动器即退」，不能用 proc.kill()，得走 CDP 关
  try { await cdp?.send('Browser.close'); } catch { /* noop */ }
  await sleep(300);
  try { proc.kill(); } catch { /* noop */ }
}
