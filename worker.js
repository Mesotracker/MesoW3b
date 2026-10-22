/**
 * Cloudflare Worker: rewriting web proxy.
 *
 * URL schemes (both base64url):
 *   https://<worker>/?u=<b64url(full target URL)>      what the frontend sends
 *   https://<worker>/p/<b64url(origin)>/<path>?<query>  what the worker emits
 * The second form keeps the path readable, so relative URLs resolve
 * correctly by themselves (HTML, CSS, JS modules, workers, fetch()).
 * Root-relative URLs ("/x.js") that slip through are recovered from the
 * Referer. The old "/?u=<base64url>" form still works (redirects).
 *
 * Optional env:
 *   GITHUB_TOKEN   token (public-read only!) added to requests for
 *                  api.github.com / raw.githubusercontent.com, to avoid the
 *                  60 req/hr per-IP limit that shared Worker IPs hit.
 *   ALLOWED_ORIGINS comma-separated list of origins allowed to call the proxy
 *                  cross-origin (default "*").
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const STATIC_RE =
  /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp3|ogg|wav|m4a|mp4|webm|wasm|unityweb|bin|pck|gz|br)$/i;

const GITHUB_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com']);
const GITHUB_AUTH_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);

// Response headers that stop pages from being framed / rewritten / loaded.
const STRIP_RESPONSE = [
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'cross-origin-embedder-policy', 'cross-origin-opener-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'strict-transport-security',
  'referrer-policy', 'report-to', 'nel', 'reporting-endpoints', 'clear-site-data',
  'alt-svc', 'public-key-pins', 'x-xss-protection',
];

const FORWARD_REQUEST = [
  'accept', 'accept-language', 'content-type', 'range', 'if-range',
  'if-none-match', 'if-modified-since', 'x-requested-with', 'cache-control', 'pragma',
];

const URL_ATTRS = ['src', 'href', 'action', 'poster', 'data', 'formaction'];

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      return page(502, 'Proxy error', `<p>${esc(String(e && e.message || e))}</p>`);
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env, true) });
  }

  // Legacy "/?u=<base64url>" links.
  const legacy = url.searchParams.get('u');
  if (legacy && !url.pathname.startsWith('/p/')) {
    try {
      const t = new URL(b64d(legacy));
      return redirect(proxify(t.href, t.href, origin), 302);
    } catch {
      return page(400, 'Bad request', '<p>Invalid <code>u</code> parameter.</p>');
    }
  }

  let target = parseProxyPath(url);

  // Root-relative request that escaped rewriting: recover target from Referer.
  if (!target) {
    const ref = refererTarget(request, origin);
    if (ref && request.headers.get('upgrade') !== 'websocket') {
      const t = new URL(ref.origin + url.pathname + url.search);
      return redirect(proxify(t.href, t.href, origin), 307);
    }
    if (url.pathname === '/') {
      return page(200, 'Proxy online', '<p>Worker is running. Use it through the frontend.</p>');
    }
    return page(404, 'Not found', '<p>Unknown route.</p>');
  }

  if (isBlockedHost(target.hostname) || target.host === url.host) {
    return page(403, 'Blocked', '<p>That host is not allowed.</p>');
  }

  if (request.headers.get('upgrade') === 'websocket') {
    return proxyWebSocket(request, target);
  }

  const method = request.method;
  const isGet = method === 'GET' || method === 'HEAD';

  /* ---- upstream request ---- */
  const h = new Headers();
  for (const k of FORWARD_REQUEST) {
    const v = request.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set('user-agent', request.headers.get('user-agent') || DEFAULT_UA);
  h.set('referer', (refererTarget(request, origin) || target).href.split('#')[0]);
  if (!isGet || request.headers.get('origin')) h.set('origin', target.origin);
  const cookie = filterCookies(request.headers.get('cookie'), target.hostname);
  if (cookie) h.set('cookie', cookie);

  const isGithub = GITHUB_HOSTS.has(target.hostname);
  if (env.GITHUB_TOKEN && GITHUB_AUTH_HOSTS.has(target.hostname)) {
    h.set('authorization', `Bearer ${env.GITHUB_TOKEN}`);
  }

  // Cache static assets at the edge so repeat loads never hit the origin.
  const cf = {};
  if (isGet && !h.has('authorization')) {
    if (isGithub) {
      cf.cacheEverything = true;
      cf.cacheTtlByStatus = { '200-299': 600, '404': 60, '500-599': 0 };
    } else if (STATIC_RE.test(target.pathname)) {
      cf.cacheEverything = true;
      cf.cacheTtlByStatus = { '200-299': 3600, '301-302': 600, '404': 60, '500-599': 0 };
    }
  }

  const init = { method, headers: h, redirect: 'manual', cf };
  if (!isGet) init.body = request.body;

  const res = await fetchWithRetry(target.href, init, isGet);

  /* ---- response ---- */
  const headers = new Headers(res.headers);
  for (const k of STRIP_RESPONSE) headers.delete(k);

  // Cookies: namespace per site so sites don't clobber each other.
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  headers.delete('set-cookie');
  for (const sc of setCookies) {
    const c = rewriteSetCookie(sc, target.hostname);
    if (c) headers.append('set-cookie', c);
  }

  const loc = headers.get('location');
  if (loc && res.status >= 300 && res.status < 400) {
    headers.set('location', proxify(loc, target.href, origin));
  }

  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
  headers.set('referrer-policy', 'same-origin');

  const ct = (headers.get('content-type') || '').toLowerCase();
  const rewritable = res.status !== 204 && res.status !== 304 && method !== 'HEAD' && !(res.status >= 300 && res.status < 400);

  // Browser-side caching: fewer repeat hits on the worker itself.
  if (res.status === 200 && isGet && STATIC_RE.test(target.pathname)) {
    const cc = headers.get('cache-control') || '';
    const age = parseInt((cc.match(/max-age=(\d+)/) || [])[1] || '0', 10);
    if (age < 3600 && !/no-store/i.test(cc)) headers.set('cache-control', 'public, max-age=3600');
  }

  if (rewritable && /text\/html|application\/xhtml/.test(ct)) {
    scrub(headers);
    return new Response(rewriteHtml(res, target, origin).body, { status: res.status, statusText: res.statusText, headers });
  }
  if (rewritable && /text\/css/.test(ct)) {
    scrub(headers);
    const text = await res.text();
    return new Response(rewriteCss(text, target.href, origin), { status: res.status, headers });
  }
  if (rewritable && /mpegurl/.test(ct)) {
    scrub(headers);
    const text = await res.text();
    return new Response(rewriteM3u8(text, target.href, origin), { status: res.status, headers });
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Body changes, so these upstream validators / lengths no longer apply.
function scrub(headers) {
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');
  headers.delete('last-modified');
  headers.delete('content-md5');
}

async function fetchWithRetry(url, init, canRetry) {
  let res;
  for (let i = 0; i < 3; i++) {
    res = await fetch(url, init);
    if (canRetry && i < 2 && (res.status === 429 || res.status === 503)) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const wait = Math.min(Number.isFinite(ra) ? ra * 1000 : 400 * (i + 1) ** 2, 2500);
      await new Promise(r => setTimeout(r, wait + Math.random() * 150));
      continue;
    }
    break;
  }
  return res;
}

async function proxyWebSocket(request, target) {
  const u = new URL(target.href);
  u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
  const h = new Headers(request.headers);
  h.set('origin', u.origin);
  h.delete('cookie');
  const cookie = filterCookies(request.headers.get('cookie'), target.hostname);
  if (cookie) h.set('cookie', cookie);
  return fetch(u.href, { headers: h });
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

function parseProxyPath(url) {
  const m = url.pathname.match(/^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (!m) return null;
  try {
    const o = new URL(b64d(m[1]));
    if (!/^(https?|wss?):$/.test(o.protocol)) return null;
    return new URL(`${o.origin}${m[2] || '/'}${url.search}`);
  } catch { return null; }
}

// Target URL of the page that made this request, if it came through us.
function refererTarget(request, origin) {
  const ref = request.headers.get('referer');
  if (!ref) return null;
  try {
    const r = new URL(ref);
    if (r.origin !== origin) return null;
    return parseProxyPath(r);
  } catch { return null; }
}

function proxify(u, base, origin) {
  if (!u) return u;
  const s = u.trim();
  if (!s || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(s)) return u;
  let a;
  try { a = new URL(s, base); } catch { return u; }
  if (!/^(https?|wss?):$/.test(a.protocol)) return u;
  return `${origin}/p/${b64e(a.origin)}${a.pathname}${a.search}${a.hash}`;
}

function isBlockedHost(h) {
  h = h.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    h === '[::1]' || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h);
}

function b64e(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64d(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function redirect(location, status) {
  return new Response(null, { status, headers: { location } });
}

function corsHeaders(request, env, preflight) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const reqOrigin = request.headers.get('origin');
  const o = allowed.includes('*') ? '*' : allowed.includes(reqOrigin) ? reqOrigin : allowed[0];
  const h = { 'access-control-allow-origin': o, 'access-control-expose-headers': '*', vary: 'Origin' };
  if (preflight) {
    h['access-control-allow-methods'] = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';
    h['access-control-allow-headers'] = request.headers.get('access-control-request-headers') || '*';
    h['access-control-max-age'] = '86400';
  }
  return h;
}

function esc(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function page(status, title, body) {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>${esc(title)}</title>` +
    `<body style="font:15px system-ui;background:#0b1220;color:#e5e7eb;padding:40px"><h2>${esc(title)}</h2>${body}`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' } },
  );
}

/* ------------------------------------------------------------------ */
/* Cookies (namespaced as  pxy~<domain>~<name>)                        */
/* ------------------------------------------------------------------ */

function filterCookies(header, host) {
  if (!header) return '';
  const out = [];
  for (const c of header.split(/;\s*/)) {
    const m = c.match(/^pxy~([^~=]+)~([^=]*)=([\s\S]*)$/);
    if (m && (host === m[1] || host.endsWith('.' + m[1]))) out.push(`${m[2]}=${m[3]}`);
  }
  return out.join('; ');
}

function rewriteSetCookie(sc, host) {
  const parts = sc.split(';');
  const nv = parts.shift();
  const eq = nv.indexOf('=');
  if (eq < 1) return null;
  const name = nv.slice(0, eq).trim();
  const val = nv.slice(eq + 1);
  let dom = host;
  const keep = [];
  for (const p of parts) {
    const kv = p.trim();
    const l = kv.toLowerCase();
    if (l.startsWith('domain=')) dom = kv.slice(7).replace(/^\./, '').toLowerCase();
    else if (l.startsWith('path=') || l === 'secure' || l.startsWith('samesite') || l === 'partitioned') continue;
    else if (kv) keep.push(kv);
  }
  if (!(host === dom || host.endsWith('.' + dom))) return null;
  // SameSite=None; Secure; Partitioned so cookies survive being inside a cross-site iframe.
  return `pxy~${dom}~${name}=${val}; ${[...keep, 'Path=/', 'SameSite=None', 'Secure', 'Partitioned'].join('; ')}`;
}

/* ------------------------------------------------------------------ */
/* Rewriters                                                           */
/* ------------------------------------------------------------------ */

function rewriteCss(css, base, origin) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) =>
      /^(data:|#)/i.test(u) ? m : `url(${q}${proxify(u, base, origin)}${q})`)
    .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) => `@import ${q}${proxify(u, base, origin)}${q}`);
}

function rewriteM3u8(text, base, origin) {
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${proxify(u, base, origin)}"`);
    }
    return proxify(line, base, origin);
  }).join('\n');
}

function rewriteSrcset(v, base, origin) {
  if (/data:/i.test(v)) return v;
  return v.split(',').map(part => {
    const [u, ...d] = part.trim().split(/\s+/);
    return u ? [proxify(u, base, origin), ...d].join(' ') : part;
  }).join(', ');
}

function rewriteHtml(res, target, origin) {
  let base = target.href;
  let injected = false;
  const shimTag = `<script>${shimSource({ w: origin, t: target.href })}</script>`;

  const rewriter = new HTMLRewriter()
    .on('base', {
      element(el) {
        const href = el.getAttribute('href');
        if (href) { try { base = new URL(href, base).href; } catch { /* keep */ } }
        el.remove();
      },
    })
    .on('head', {
      element(el) { injected = true; el.prepend(shimTag, { html: true }); },
    })
    .on('meta', {
      element(el) {
        const he = (el.getAttribute('http-equiv') || '').toLowerCase();
        if (he === 'content-security-policy' || he === 'x-frame-options' || (el.getAttribute('name') || '').toLowerCase() === 'referrer') {
          el.remove();
        } else if (he === 'refresh') {
          const c = el.getAttribute('content') || '';
          el.setAttribute('content', c.replace(/(url\s*=\s*)(['"]?)([^'";]+)\2/i, (m, p, q, u) => p + q + proxify(u, base, origin) + q));
        }
      },
    })
    .on('[integrity]', { element(el) { el.removeAttribute('integrity'); } })
    .on('a[target], form[target]', {
      element(el) {
        const t = (el.getAttribute('target') || '').toLowerCase();
        if (t === '_top' || t === '_parent') el.setAttribute('target', '_self');
      },
    })
    .on('[src],[href],[action],[poster],[data],[formaction]', {
      element(el) {
        for (const n of URL_ATTRS) {
          const v = el.getAttribute(n);
          if (v != null) {
            const nv = proxify(v, base, origin);
            if (nv !== v) el.setAttribute(n, nv);
          }
        }
      },
    })
    .on('[srcset],[imagesrcset]', {
      element(el) {
        for (const n of ['srcset', 'imagesrcset']) {
          const v = el.getAttribute(n);
          if (v) el.setAttribute(n, rewriteSrcset(v, base, origin));
        }
      },
    })
    .on('[style]', {
      element(el) { el.setAttribute('style', rewriteCss(el.getAttribute('style'), base, origin)); },
    });

  let styleBuf = '';
  rewriter.on('style', {
    text(t) {
      styleBuf += t.text;
      if (t.lastInTextNode) { t.replace(rewriteCss(styleBuf, base, origin), { html: true }); styleBuf = ''; }
      else t.remove();
    },
  });

  rewriter.onDocument({
    end(end) { if (!injected) end.append(shimTag, { html: true }); },
  });

  return rewriter.transform(res);
}

/* ------------------------------------------------------------------ */
/* Client-side shim, injected into every HTML page                     */
/* ------------------------------------------------------------------ */

function shimSource(cfg) {
  return SHIM.replace('__CFG__', () => JSON.stringify(cfg).replace(/</g, '\\u003c'));
}

const SHIM = String.raw`(function(){
var C=__CFG__;
if(window.__px)return;window.__px=1;
var W=C.w,T=C.t,PRE=W+'/p/',WPRE=W.replace(/^http/,'ws')+'/p/';
var SKIP=/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i;
function cur(){
  var m=location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/);
  try{return m?b64d(m[1])+(m[2]||'/')+location.search:T;}catch(e){return T;}
}
function b64e(s){return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function b64d(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return atob(s);}
function px(u,base){
  if(u==null)return u;
  var s=String(u);
  if(!s||SKIP.test(s)||s.indexOf(PRE)===0||s.indexOf(WPRE)===0)return u;
  var a;try{a=new URL(s,base||cur());}catch(e){return u;}
  if(a.origin===W){try{a=new URL(a.pathname+a.search+a.hash,cur());}catch(e){return u;}}
  var p=a.protocol;
  if(p!=='http:'&&p!=='https:'&&p!=='ws:'&&p!=='wss:')return u;
  var o=(p==='ws:'||p==='wss:')?WPRE.slice(0,-3):W;
  return o+'/p/'+b64e(a.origin)+a.pathname+a.search+a.hash;
}
function unpx(u){
  if(typeof u!=='string'||u.indexOf(PRE)!==0)return u;
  var m=u.slice(PRE.length).match(/^([A-Za-z0-9_-]+)(.*)$/);
  try{return m?b64d(m[1])+(m[2]||'/'):u;}catch(e){return u;}
}
function hook(proto,prop){
  if(!proto)return;
  var d=Object.getOwnPropertyDescriptor(proto,prop);
  if(!d||!d.set)return;
  Object.defineProperty(proto,prop,{configurable:true,enumerable:d.enumerable,
    get:function(){return unpx(d.get.call(this));},
    set:function(v){d.set.call(this,px(v));}});
}
[['HTMLScriptElement','src'],['HTMLImageElement','src'],['HTMLIFrameElement','src'],['HTMLMediaElement','src'],
 ['HTMLSourceElement','src'],['HTMLTrackElement','src'],['HTMLEmbedElement','src'],['HTMLInputElement','src'],
 ['HTMLLinkElement','href'],['HTMLAnchorElement','href'],['HTMLAreaElement','href'],['HTMLFormElement','action'],
 ['HTMLObjectElement','data'],['HTMLVideoElement','poster']
].forEach(function(p){hook(window[p[0]]&&window[p[0]].prototype,p[1]);});

var ATTRS=['src','href','action','poster','data','formaction'];
var sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){
  if(ATTRS.indexOf(String(n).toLowerCase())>=0)v=px(v);
  return sa.call(this,n,v);
};

// innerHTML / insertAdjacentHTML: rewrite URLs in the markup before it goes live.
var ih=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
function fixHTML(html){
  html=String(html);
  if(!/(src|href|action|poster|data)\s*=/i.test(html))return html;
  var t=document.createElement('template');
  ih.set.call(t,html);
  var els=t.content.querySelectorAll('[src],[href],[action],[poster],[data],[formaction]');
  for(var i=0;i<els.length;i++){
    for(var j=0;j<ATTRS.length;j++){
      var n=ATTRS[j];
      if(els[i].hasAttribute(n)){var v=els[i].getAttribute(n),nv=px(v);if(nv!==v)sa.call(els[i],n,nv);}
    }
  }
  return ih.get.call(t);
}
if(ih&&ih.set){
  Object.defineProperty(Element.prototype,'innerHTML',{configurable:true,enumerable:ih.enumerable,
    get:ih.get,set:function(v){ih.set.call(this,fixHTML(v));}});
}
var iah=Element.prototype.insertAdjacentHTML;
Element.prototype.insertAdjacentHTML=function(pos,html){return iah.call(this,pos,fixHTML(html));};

// fetch / XHR / beacon / open
var of=window.fetch;
window.fetch=function(i,o){
  if(typeof i==='string'||(window.URL&&i instanceof URL))i=px(i);
  return of.call(this,i,o);
};
var OR=window.Request;
window.Request=function(i,o){
  if(typeof i==='string'||(window.URL&&i instanceof URL))i=px(i);
  return new OR(i,o);
};
window.Request.prototype=OR.prototype;
var xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){
  var a=[].slice.call(arguments);a[1]=px(a[1]);return xo.apply(this,a);
};
if(navigator.sendBeacon){
  var sb=navigator.sendBeacon;
  navigator.sendBeacon=function(u,d){return sb.call(navigator,px(u),d);};
}
var wo=window.open;
window.open=function(u){var a=[].slice.call(arguments);if(u)a[0]=px(u);return wo.apply(window,a);};

// WebSocket / EventSource / Worker
var WS=window.WebSocket;
window.WebSocket=function(u,p){return p===undefined?new WS(px(u)):new WS(px(u),p);};
window.WebSocket.prototype=WS.prototype;
['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){window.WebSocket[k]=WS[k];});
if(window.EventSource){
  var ES=window.EventSource;
  window.EventSource=function(u,o){return new ES(px(u),o);};
  window.EventSource.prototype=ES.prototype;
}
['Worker','SharedWorker'].forEach(function(k){
  var O=window[k];if(!O)return;
  window[k]=function(u,o){return new O(px(u),o);};
  window[k].prototype=O.prototype;
});
if(navigator.serviceWorker){
  try{navigator.serviceWorker.register=function(){return Promise.reject(new DOMException('Service workers are disabled by the proxy','SecurityError'));};}catch(e){}
}

// Cookies: namespaced per site, same format the worker uses for Set-Cookie.
var cd=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
function chost(){try{return new URL(cur()).hostname;}catch(e){return location.hostname;}}
if(cd){
  Object.defineProperty(document,'cookie',{configurable:true,
    get:function(){
      var h=chost(),out=[];
      cd.get.call(document).split('; ').forEach(function(c){
        var m=c.match(/^pxy~([^~=]+)~([^=]*)=([\s\S]*)$/);
        if(m&&(h===m[1]||h.slice(-m[1].length-1)==='.'+m[1]))out.push(m[2]+'='+m[3]);
      });
      return out.join('; ');
    },
    set:function(s){
      var parts=String(s).split(';'),nv=parts.shift(),eq=nv.indexOf('=');
      var name=eq<0?'':nv.slice(0,eq).trim(),val=eq<0?nv:nv.slice(eq+1);
      var dom=chost(),keep=[];
      parts.forEach(function(p){
        var kv=p.trim(),l=kv.toLowerCase();
        if(l.indexOf('domain=')===0)dom=kv.slice(7).replace(/^\./,'').toLowerCase();
        else if(l.indexOf('path=')===0||l==='secure'||l.indexOf('samesite')===0||l==='partitioned'){}
        else if(kv)keep.push(kv);
      });
      cd.set.call(document,'pxy~'+dom+'~'+name+'='+val+'; '+keep.concat(['path=/','SameSite=None','Secure','Partitioned']).join('; '));
    }});
}

// Keep the parent frontend's address bar in sync, and keep history URLs proxied.
function notify(){try{parent.postMessage({__px:1,url:cur(),title:document.title},'*');}catch(e){}}
['pushState','replaceState'].forEach(function(k){
  var o=history[k];
  history[k]=function(s,t,u){if(u!=null)u=px(u);var r=o.call(this,s,t,u);notify();return r;};
});
window.addEventListener('popstate',notify);
window.addEventListener('hashchange',notify);
window.addEventListener('load',notify);
document.addEventListener('DOMContentLoaded',notify);

// location.href = "https://..." can't be hooked directly; catch it via the Navigation API (Chromium).
if(window.navigation&&navigation.addEventListener){
  navigation.addEventListener('navigate',function(e){
    if(!e.cancelable||e.downloadRequest||e.hashChange||e.formData)return;
    var d=e.destination.url;
    if(!/^https?:/i.test(d)||d.indexOf(PRE)===0)return;
    var a=new URL(d);
    if(a.origin===W)return;
    e.preventDefault();
    location.href=px(d);
  });
}
})();`;
