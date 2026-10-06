'use strict';
/**
 * RoomTalk · Cloudflare Workers 入口
 * ===========================================================================
 * 路由只有两条：
 *
 *   /ws      WebSocket 信令 → SignalRoom（Durable Object）
 *   /*       静态页面        → Assets 直接命中，**不进 Worker、不计费**
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 域名归一（只对本 Worker 绑定的域名生效，workers.dev 等不受影响）
    const canonical = normalizeHost(url.hostname.toLowerCase());
    if (canonical) {
      return Response.redirect(url.protocol + '//' + canonical + url.pathname + url.search, 301);
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
