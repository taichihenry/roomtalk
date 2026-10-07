'use strict';
/**
 * RoomTalk · Cloudflare Workers 入口
 * ===========================================================================
 * 路由只有两条：
 *
 *   /ws      WebSocket 信令 → SignalRoom（Durable Object）
 *   /*       静态页面        → Assets 直接命中，**不进 Worker、不计费**
 *
 * 在这两条之前还有一道**前置归一**：把 http 与 www / 繁体域名
 * 一次性 301 到 `https://简体裸域`（见 fetch 里的注释，那里写了为什么 http
 * 必须跳走 —— 一句话：crypto.subtle 与 navigator.mediaDevices 只在
 * 安全上下文里存在，停在 http 连房间都进不去）。
 *
 * 静态资源优先匹配是 Workers Static Assets 的默认行为，所以整站运行起来
 * 只消耗「信令」这一条的额度：一次通话的开销 ≈ 建连 1 次 + SDP/ICE 几十条消息
 * （WS 入站消息按 20:1 折算成请求），闲聊一小时的消息量也微不足道。
 *
 * 部署：在本目录执行 `npx wrangler deploy`
 */

import { SignalRoom } from './room.js';

export { SignalRoom };

/**
 * 把域名的各种写法收归到一个规范形式。
 *
 * 为什么要做：房间号存在浏览器的 sessionStorage 里，而 sessionStorage
 * **是按 origin 隔离的** —— 用户在 www.8.中国 输一次口令，再打开 8.中国
 * 就「房间没了」，得重输。简体/繁体同理。
 * 所以把变体统一 301 到简体裸域，保证整站只有一个 origin。
 *
 * ⚠ 国际化域名在这里有坑：`new URL(...).hostname` 返回 punycode 还是 Unicode，
 *   属于实现细节（Workers 与浏览器不一定一致）。所以两个后缀**都要判**，
 *   只写 punycode 的话，若运行时给的是 `8.中國` 就静默不跳转 —— 不报错、
 *   看着也正常，只是繁体用户被分到了另一个 origin。
 *
 * @returns {string|null} 需要跳转时返回目标主机名，否则 null
 */
function normalizeHost(host) {
  const lower = host.toLowerCase();
  let h = lower;
  if (h.startsWith('www.')) h = h.slice(4);
  h = h
    .replace(/\.xn--fiqz9s$/, '.xn--fiqs8s')   // 繁體 .中國 → 简体 .中国
    .replace(/\.中國$/, '.中国');
  return h === lower ? null : h;
}

/**
 * 这个请求是不是**真的经过了 Cloudflare 边缘**？
 *
 * ⚠ 判别「本地」不能用 `url.hostname` / `Host` 头 —— 这里真踩过：
 *   `wrangler dev` 会把请求**伪装成生产域名**（因为 wrangler.toml 的 routes
 *   绑了 `8.xn--fiqs8s`）。实测本地访问 127.0.0.1:8787 时，
 *   `request.url` = `http://8.xn--fiqs8s/healthz`，`Host` 头也是它，
 *   **端口还被抹掉了** —— 单看 URL 根本分不出本地还是线上。
 *
 * ⚠ 也**不能用 `cf-connecting-ip`** —— 本地 dev 会把它设成 `127.0.0.1`，
 *   我第一版就栽在这上面（本地全被 301 走，e2e 直接跑不了）。
 *
 * 可用的判别：下面这三个头**只有边缘才会注入**。本地实测的完整头列表是
 *   accept / accept-encoding / cf-connecting-ip / host /
 *   mf-original-hostname / user-agent
 * —— 三个都不在其中。多列两个是留冗余：将来某个头被改掉时，不至于整条
 * 规则静默失效（那是这个项目最不想再遇到的一类 bug）。
 */
function cameFromEdge(request) {
  const h = request.headers;
  return !!(h.get('cf-ray') || h.get('cf-visitor') || h.get('x-forwarded-proto'));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ---------------------- 协议与域名一次性归一 ----------------------
     * 目标：把「协议」和「域名写法」一起收归到唯一形式 —— https + 简体裸域。
     *
     * 为什么 http 必须 301 走，而不能照常返回页面：
     *
     *   ① 本项目的两个核心 API 都**只存在于安全上下文**（https 或 localhost）：
     *        · 口令派生房间号 → crypto.subtle（见 app.js 的 deriveRoomId）
     *        · 麦克风 / 摄像头 → navigator.mediaDevices
     *      真让用户停在 http，他连房间都进不去，只会撞上 app.js 里那句
     *      「当前地址不是安全上下文，浏览器不支持加密与音视频」。
     *      —— 也就是说，http 下这个站点是**完全不能用**的，不是「凑合能用」。
     *
     *   ② 手机浏览器手输裸域名时默认补 `http://`；而 HSTS 只在 **https 响应**
     *      上生效（规范要求浏览器忽略 http 响应里的 HSTS —— Cloudflare 即使在
     *      http 响应里带了那个头也没用）。所以用户的「第一次」永远落在 http。
     *      HSTS 只能管「来过一次之后」，服务端 301 才能管「第一次」——
     *      这正是「每次都得手动把 http 改成 https」的根因。
     *
     * 只在**经过边缘**的请求上做（见 cameFromEdge）：本地 `wrangler dev` 会把
     * 请求伪装成 `http://8.xn--fiqs8s/`，不加这道闸本地开发与 e2e 会被全线跳走。
     *
     * 覆盖范围：wrangler.toml 里 `run_worker_first = ["/", "/index.html"]`，
     * 所以这条规则对**页面请求**必然生效（就是用户在地址栏敲的那个）；静态资源
     * 本身直连 Assets 不走 Worker，但页面被跳到 https 后，子资源自然也是 https。
     * 想在边缘把**所有路径**（含静态资源）都兜住，可另开 Cloudflare Zone 的
     * 「Always Use HTTPS」—— 那是边缘动作，在 Worker 之前执行、零代码。
     */
    const insecure = cameFromEdge(request) && url.protocol === 'http:';
    const canonical = normalizeHost(url.hostname.toLowerCase());
    if (insecure || canonical) {
      return Response.redirect('https://' + (canonical || url.hostname) + url.pathname + url.search, 301);
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('需要 WebSocket 升级请求', {
          status: 426,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      // 全局单一实例：整张房间表在它的内存里
      const id = env.SIGNAL.idFromName('global');
      return env.SIGNAL.get(id).fetch(request);
    }

    // 给运维/自检留一个轻量端点，不碰 DO
    if (url.pathname === '/healthz') {
      return new Response('ok', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
