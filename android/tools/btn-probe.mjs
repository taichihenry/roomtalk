'use strict';
/* ===========================================================================
   通话按钮「到底是白的还是深的」—— 用像素说话。

   为什么需要：靠肉眼看手机截图分辨 56dp 小圆点上的深浅，误差比结论还大。
   这个脚本把 PNG 解出来，在每颗按钮中心周围取一圈像素求均值：
   白底 ≈ (255,255,255)，深底 ≈ (60~90, …)。一眼定案，不靠猜。

   零依赖：PNG 用 Node 自带的 zlib 手动解（只处理 8bit RGB/RGBA + 5 种行滤波）。

   用法：
     node tools/btn-probe.mjs shot.png mic=330,1358 spk=540,1358 hup=750,1358
   =========================================================================== */

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let w = 0, h = 0, depth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (depth !== 8) throw new Error('只支持 8bit，实际 ' + depth);
      if (colorType !== 2 && colorType !== 6) throw new Error('只支持 RGB/RGBA，实际 ' + colorType);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, px: out };
}

/** 在 (cx,cy) 周围半径 r 的一圈上取 12 个点，返回均值。避开中间的图标。 */
function ringAvg(img, cx, cy, r) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(t) * r);
    const y = Math.round(cy + Math.sin(t) * r);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    const o = (y * img.w + x) * img.bpp;
    sr += img.px[o]; sg += img.px[o + 1]; sb += img.px[o + 2];
    n++;
  }
  return n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : null;
}

/**
 * 读**图标**的颜色。
 *
 * 做法：在中心半径 r 内只采「有彩色」的像素（max-min > 50），灰底／黑底不参与。
 * 为什么不能直接对圆盘求均值：图标是细笔画，周围大片深底会把颜色稀释成灰，
 * 绿和红都会被冲淡到分不出来。
 */
function iconColor(img, cx, cy, r) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      const o = (y * img.w + x) * img.bpp;
      const R = img.px[o], G = img.px[o + 1], B = img.px[o + 2];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if (mx - mn < 50) continue;
      sr += R; sg += G; sb += B; n++;
    }
  }
  if (!n) return null;
  return { rgb: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)], n };
}

/**
 * 数中心区里「接近纯白」的像素个数 —— 用来回答「图标到底是不是白的」。
 *
 * 为什么不能复用 [iconColor]：那个函数采的是**有彩色**像素（max-min > 50），
 * 白图标恰恰是最没彩色的，会被它整个滤掉 —— 最后统计到的是「圆底漏进中心区的
 * 绿/红」，看着像「图标是绿的」，其实是底色。两个问题问的是相反的东西，
 * 必须分开算。
 */
function whitePx(img, cx, cy, r) {
  let n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      const o = (y * img.w + x) * img.bpp;
      const R = img.px[o], G = img.px[o + 1], B = img.px[o + 2];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if (mx - mn <= 40 && mx > 200) n++;     // 无色偏 + 够亮
    }
  }
  return n;
}

/**
 * 把一个颜色归类成 绿 / 红 / 白 / 深。
 *
 * 通话按钮现在靠**底色**表达开关（实心绿=开、实心红=关，图标恒白），
 * 所以判定要看外圈那一环，而不是图标本身。
 */
function classify(c) {
  if (!c) return '无色';
  const [R, G, B] = c;
  if (G > R + 30 && G > B + 30) return '🟢 绿';
  if (R > G + 30 && R > B + 30) return '🔴 红';
  const lum = 0.299 * R + 0.587 * G + 0.114 * B;
  if (lum > 200) return '⬜ 白';
  if (lum < 60) return '⬛ 深';
  return `⚪ rgb(${c})`;
}

const [file, ...points] = process.argv.slice(2);
if (!file || !points.length) {
  console.error('用法: node tools/btn-probe.mjs shot.png mic=330,2154 spk=540,2154');
  process.exit(2);
}

const img = decodePng(readFileSync(file));
console.log(`[px] ${file}  ${img.w}x${img.h}  bpp=${img.bpp}`);
for (const p of points) {
  const [name, xy] = p.split('=');
  const [x, y] = xy.split(',').map(Number);
  const bg = ringAvg(img, x, y, 62);      // 外缘一圈 → 底色（真正的状态载体）
  const white = whitePx(img, x, y, 26);   // 中心 → 白图标像素数
  console.log(
    `[px]  ${name.padEnd(6)} @${x},${y}  底色=${classify(bg)} rgb(${bg})` +
    `   白图标=${white}px ${white >= 60 ? '✅' : '❌（太少了，图标不是白的？）'}`,
  );
}
process.exit(0);
