import type { BrowserType } from '@playwright/test';

export class RefusedError extends Error {}

export interface CaptureOptions {
  url: string;
  out: string;
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark';
  fullPage?: boolean;
  chromium: BrowserType;
  timeoutMs?: number;
}

export function isLocalUrl(raw: string, protocols?: ReadonlySet<string>): boolean;
export function resolveOutputPath(arg: string | undefined, screenshotsDir: string): string;
export function writePngAtomic(target: string, buf: Buffer): void;
export function capture(opts: CaptureOptions): Promise<string>;
