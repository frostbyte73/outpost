import { closeSync, constants, createReadStream, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { Server } from '../server.js';
import { SCREENSHOT_NAME_RE } from '../permissions/screenshot/capture.mjs';

export interface ScreenshotRoutesDeps {
  screenshotsDir: string;
}

const PREFIX = '/api/screenshots/';

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.end('not found');
}

// SCREENSHOT_NAME_RE is the whole traversal guard: it admits no separator, percent-escape or extra dot.
export function registerScreenshotRoutes(server: Server, { screenshotsDir }: ScreenshotRoutesDeps): void {
  server.route('GET', `${PREFIX}:name`, (req, res) => {
    const name = new URL(req.url ?? '', 'http://internal').pathname.slice(PREFIX.length);
    if (!SCREENSHOT_NAME_RE.test(name)) return notFound(res);
    let fd: number;
    try {
      fd = openSync(join(screenshotsDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return notFound(res);
    }
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      return notFound(res);
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'image/png');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'");
    res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    pipeline(createReadStream('', { fd }), res, () => {});
  });
}
