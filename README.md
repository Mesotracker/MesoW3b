# web-prox

`index.html` is the frontend. `worker.js` is the Cloudflare Worker it talks to.

## Deploy
    npx wrangler deploy
Paste the `*.workers.dev` URL into the frontend's ⚙ Settings.

## What the worker does
- Proxy URLs look like `/?u=<base64url(url)>`, so relative URLs just work.
- Rewrites HTML, inline/external CSS, srcset, meta-refresh, HLS playlists, redirects, cookies.
- Strips CSP / X-Frame-Options / COEP / CORP so assets and iframes aren't refused.
- Injects a client shim: patches fetch, XHR, WebSocket, Worker, setAttribute/src setters,
  innerHTML, history, document.cookie, window.open, and catches `location.href = ...`
  (Chromium Navigation API).
- Rate limits: edge-caches static assets (1h), sets browser Cache-Control, retries 429/503
  with Retry-After, sends a real browser UA, and can attach `GITHUB_TOKEN`
  (`npx wrangler secret put GITHUB_TOKEN`, public-read scope only) for api/raw.githubusercontent.com.

## Limits
- Not a full rewriting engine like Ultraviolet/Scramjet: JS that reads `location.hostname`,
  site-locks, or uses `eval`-built URLs may still escape or misbehave.
- All proxied sites share one origin (localStorage is shared).
- Cloudflare free plan = 100k requests/day; a game with many assets uses many. Set
  `ALLOWED_ORIGINS` so only your frontend can use the worker.
