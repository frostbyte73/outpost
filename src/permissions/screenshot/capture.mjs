// Plain ESM: the daemon installs this file verbatim and runs it with node, not tsx.
import { openSync, writeSync, closeSync, renameSync, unlinkSync, mkdirSync, realpathSync, constants } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const HTTP = new Set(['http:', 'https:']);
const WS = new Set(['ws:', 'wss:']);
const MAX_REDIRECTS = 10;
const OUT_RE = /^\/tmp\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.png$/;
/** A name resolveOutputPath generates under the screenshots dir: the only files the daemon serves. */
export const SCREENSHOT_NAME_RE = /^[0-9]{1,16}-[0-9a-f]{8}\.png$/;
const USAGE = 'usage: outpost-screenshot [--width N] [--height N] [--color-scheme light|dark] [--full-page] <http://localhost…> [/tmp/<name>.png]';

/** A URL, output path or in-page request the tool will not touch. */
export class RefusedError extends Error {}

/** True when `raw` parses to one of `protocols` on exactly localhost, 127.0.0.1 or [::1], with no userinfo. */
export function isLocalUrl(raw, protocols = HTTP) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  return protocols.has(u.protocol) && u.username === '' && u.password === '' && LOCAL_HOSTS.has(u.hostname);
}

/** The PNG path for a CLI output operand: a fresh file under screenshotsDir, or a direct child of /tmp. */
export function resolveOutputPath(arg, screenshotsDir) {
  if (arg === undefined) return join(screenshotsDir, `${Date.now()}-${randomBytes(4).toString('hex')}.png`);
  if (!OUT_RE.test(arg)) throw new RefusedError(`refused: output must be /tmp/<name>.png, got ${arg}`);
  return arg;
}

export function writePngAtomic(target, buf) {
  // rename replaces a symlink planted at target rather than writing through it.
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeSync(fd, buf); } finally { closeSync(fd); }
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw e;
  }
}

function isSameOrigin(raw, origin, protocols = HTTP) {
  if (!isLocalUrl(raw, protocols)) return false;
  const u = new URL(raw);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  return u.origin === origin;
}

/** Screenshots a local URL to `out`, refusing if the page makes any cross-origin or non-GET request. */
export async function capture({ url, out, width = 1280, height = 800, colorScheme = 'light', fullPage = false, chromium, timeoutMs = 30_000 }) {
  if (!isLocalUrl(url)) throw new RefusedError(`refused: ${url} is not a local URL`);
  // Same origin, not just any loopback host: page JS must not reach other local services, the daemon's API included.
  const origin = new URL(url).origin;
  const browser = await chromium.launch({
    headless: true,
    // DNS prefetch and WebRTC never reach context.route, so they get no resolver and no UDP.
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  try {
    // A service worker's fetches bypass context.route, so none may register.
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, serviceWorkers: 'block', ignoreHTTPSErrors: true });
    let refused = null;
    let failed = null;
    let redirectedTo = null;
    let page;
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (!isSameOrigin(req.url(), origin) || !['GET', 'HEAD'].includes(req.method())) {
        refused ??= `${req.method()} ${req.url()}`;
        return route.abort('blockedbyclient');
      }
      try {
        // Redirects are followed here, hop by hop: a fulfilled 3xx is followed by Chromium without re-entering the route.
        let target = req.url();
        for (let hop = 0; ; hop++) {
          const response = await route.fetch({ url: target, maxRedirects: 0 });
          const location = response.status() >= 300 && response.status() < 400 && response.headers().location;
          if (!location) {
            // Fulfilled under the original URL, a redirected page would resolve its relative assets against the wrong base.
            if (target !== req.url() && req.isNavigationRequest() && req.frame() === page.mainFrame()) {
              redirectedTo = target;
              return await route.abort('aborted');
            }
            return await route.fulfill({ response });
          }
          target = new URL(location, target).href;
          if (hop >= MAX_REDIRECTS || !isSameOrigin(target, origin)) {
            refused ??= `redirect to ${target}`;
            return await route.abort('blockedbyclient');
          }
        }
      } catch (e) {
        failed ??= `${req.method()} ${req.url()}: ${e.message}`;
        return route.abort('failed');
      }
    });
    await context.routeWebSocket(/.*/, (ws) => {
      if (isSameOrigin(ws.url(), origin, WS)) ws.connectToServer();
      else { refused ??= ws.url(); ws.close(); }
    });
    const throwIfBlocked = () => {
      if (refused) throw new RefusedError(`refused: page requested ${refused}`);
      if (failed) throw new Error(`request failed: ${failed}`);
    };
    page = await context.newPage();
    for (let next = url, attempt = 0; ; attempt++) {
      redirectedTo = null;
      try {
        await page.goto(next, { waitUntil: 'networkidle', timeout: timeoutMs });
      } catch (e) {
        if (!refused && !failed && !redirectedTo) throw e;
      }
      throwIfBlocked();
      if (!redirectedTo) break;
      if (attempt >= MAX_REDIRECTS) throw new RefusedError(`refused: too many redirects from ${url}`);
      next = redirectedTo;
    }
    if (!isSameOrigin(page.url(), origin)) throw new RefusedError(`refused: page ended at ${page.url()}`);
    const png = await page.screenshot({ fullPage });
    // A request the page made after it settled is blocked too, and must fail the capture like one made before.
    throwIfBlocked();
    writePngAtomic(out, png);
    return out;
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  const int = (v) => {
    if (!/^[0-9]+$/.test(v ?? '') || +v < 16 || +v > 10000) throw new UsageError();
    return +v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--width') opts.width = int(argv[++i]);
    else if (a === '--height') opts.height = int(argv[++i]);
    else if (a === '--color-scheme') {
      const v = argv[++i];
      if (v !== 'light' && v !== 'dark') throw new UsageError();
      opts.colorScheme = v;
    } else if (a === '--full-page') opts.fullPage = true;
    else if (a.startsWith('-')) throw new UsageError();
    else positional.push(a);
  }
  if (positional.length < 1 || positional.length > 2) throw new UsageError();
  return { ...opts, url: positional[0], outArg: positional[1] };
}

class UsageError extends Error {}

async function main() {
  const timeoutMs = 30_000;
  setTimeout(() => { console.error('outpost-screenshot: timed out'); process.exit(1); }, timeoutMs + 10_000).unref();
  try {
    const { outArg, ...opts } = parseArgs(process.argv.slice(2));
    const dir = process.env.OUTPOST_SCREENSHOTS_DIR;
    const out = resolveOutputPath(outArg, dir);
    if (outArg === undefined) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const pw = await import(pathToFileURL(process.env.OUTPOST_SCREENSHOT_PLAYWRIGHT).href);
    const chromium = pw.chromium ?? pw.default.chromium;
    console.log(await capture({ ...opts, out, chromium, timeoutMs }));
    process.exit(0);
  } catch (e) {
    if (e instanceof UsageError) { console.error(USAGE); process.exit(2); }
    if (/Executable doesn't exist/.test(e.message)) {
      console.error('outpost-screenshot: chromium missing — run `npx playwright install chromium` in the outpost checkout (a setup step; not granted inside sessions)');
      process.exit(4);
    }
    console.error(`outpost-screenshot: ${e.message}`);
    process.exit(e instanceof RefusedError ? 3 : 1);
  }
}

// import.meta.url is the realpath, argv[1] the path as typed; they differ under a symlinked runtime dir.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
