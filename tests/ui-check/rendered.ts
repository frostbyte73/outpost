import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startDaemon, type DaemonHandle } from '../e2e/harness/daemon.js';
import { seedOpts } from './seed.js';
import type { Finding } from './static.js';

export class HarnessError extends Error {}

const AXE_PATH = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const NAV_TIMEOUT_MS = 5000;
const DESKTOP_SURFACES = ['sessions', 'tracked', 'skills', 'cockpit', 'runs', 'schedules', 'settings'];
const MOBILE_TABS = ['cockpit', 'tracked', 'sessions', 'schedules', 'more'];
const FIRST_ROW = '.o-frame-list .o-row, .o-frame-list .settings-nav-item';

type Raw = { rule: string; locator: string; detail: string };

// Runs in the page. Locators are tag + id or two classes, anchored at the nearest
// ancestor with an id/data-surface/data-tab — no nth-child, so list order can't churn them.
function overflowScan(): Raw[] {
  const out: Raw[] = [];
  const short = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    return tag + cls;
  };
  const locate = (el: Element) => {
    const anchor = el.parentElement?.closest('[id],[data-surface],[data-tab],[data-screen]');
    if (!anchor) return short(el);
    const attr = anchor.id ? '' : ['data-surface', 'data-tab', 'data-screen']
      .filter((a) => anchor.hasAttribute(a)).map((a) => `[${a}="${anchor.getAttribute(a)}"]`).join('');
    return `${short(anchor)}${attr} ${short(el)}`;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const hasOwnText = (el: Element) =>
    [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());

  for (const el of document.body.querySelectorAll('*')) {
    if (!hasOwnText(el) || !visible(el)) continue;
    const s = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis'
      && !['auto', 'scroll'].includes(s.overflowX)) {
      out.push({ rule: 'text-overflow', locator: locate(el), detail: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}` });
      continue;
    }
    // Horizontal only: a row below the fold of a vertical scroller isn't clipped text.
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (['auto', 'scroll'].includes(as.overflowX)) break;
      if (!['hidden', 'clip'].includes(as.overflowX)) continue;
      if (as.textOverflow === 'ellipsis') break;
      const ar = a.getBoundingClientRect();
      if (ar.width <= 1 || ar.height <= 1) break;
      if (r.right > ar.right + 1 || r.left < ar.left - 1) {
        out.push({ rule: 'clipped', locator: locate(el), detail: `clipped by ${short(a)}` });
      }
      break;
    }
  }
  if (document.documentElement.scrollWidth > innerWidth) {
    out.push({ rule: 'page-overflow', locator: 'html', detail: `scrollWidth ${document.documentElement.scrollWidth} > ${innerWidth}` });
  }
  return out;
}

async function axeScan(page: Page): Promise<Raw[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    // @ts-expect-error injected by addScriptTag
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return res.violations.flatMap((v: { id: string; help: string; nodes: Array<{ target: string[] }> }) =>
      // axe falls back to positional selectors; drop them so a new sibling doesn't re-key the rest.
      v.nodes.map((n) => ({ rule: v.id, locator: n.target.join(' ').replace(/:nth-(child|of-type)\(\d+\)/g, ''), detail: v.help })));
  });
}

async function click(page: Page, selector: string): Promise<void> {
  try {
    await page.locator(selector).first().click({ timeout: NAV_TIMEOUT_MS });
  } catch {
    throw new HarnessError(`ui:check could not find ${selector} — a surface was renamed or failed to render`);
  }
}

async function scanViewport(browser: Browser, baseUrl: string, name: string, width: number, height: number): Promise<Finding[]> {
  const context = await browser.newContext({ viewport: { width, height } });
  // tsx compiles with keepNames, so functions shipped to page.evaluate call an esbuild
  // `__name` helper that only exists in Node.
  await context.addInitScript('window.__name = (f) => f');
  const page = await context.newPage();
  const pending: Array<{ rule: string; msg: string; source: string }> = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const { url } = m.location();
    pending.push({ rule: 'console-error', msg: m.text(), source: url ? new URL(url).pathname : '' });
  });
  page.on('pageerror', (e) => pending.push({ rule: 'page-error', msg: e.message, source: '' }));
  const out: Finding[] = [];

  const scan = async (where: string) => {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    for (const r of await axeScan(page)) out.push({ category: 'a11y', where, ...r });
    for (const r of await page.evaluate(overflowScan)) out.push({ category: 'overflow', where, ...r });
    for (const p of pending.splice(0)) out.push({ category: 'console', rule: p.rule, where, locator: p.source, detail: p.msg });
  };

  await page.goto(baseUrl);
  if (name === 'desktop') {
    for (const key of DESKTOP_SURFACES) {
      await click(page, `.o-sidebar-item[data-surface="${key}"]`);
      await scan(`desktop:${key}`);
      // Skills detail renders a live SKILL.md, so its findings would move with doc edits.
      if (key === 'skills') continue;
      const row = page.locator(FIRST_ROW).first();
      if (await row.count()) {
        await row.click({ timeout: NAV_TIMEOUT_MS });
        await scan(`desktop:${key}/detail`);
      }
    }
  } else {
    await scan('mobile:landing');
    for (const key of MOBILE_TABS) {
      await click(page, `.m-tab[data-tab="${key}"]`);
      await scan(`mobile:${key}`);
    }
  }
  await context.close();
  return out;
}

export async function scanRendered(): Promise<Finding[]> {
  const seed = seedOpts();
  let daemon: DaemonHandle | undefined;
  let browser: Browser | undefined;
  try {
    try {
      daemon = await startDaemon(seed.opts);
    } catch (e) {
      throw new HarnessError(`test daemon failed to boot: ${(e as Error).message}`);
    }
    try {
      browser = await chromium.launch();
    } catch (e) {
      throw new HarnessError(`chromium failed to launch (try npx playwright install chromium): ${(e as Error).message}`);
    }
    return [
      ...await scanViewport(browser, daemon.baseUrl, 'desktop', 1280, 800),
      ...await scanViewport(browser, daemon.baseUrl, 'mobile', 390, 844),
    ];
  } finally {
    await browser?.close();
    if (daemon) {
      // stop() awaits an 'exit' that has already fired if the daemon died mid-run.
      const { exitCode, signalCode } = daemon.process;
      if (exitCode === null && signalCode === null) await daemon.stop();
      rmSync(daemon.runtimeDir, { recursive: true, force: true });
    }
    seed.cleanup();
  }
}
