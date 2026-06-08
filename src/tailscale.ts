import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export interface TailscaleEnv {
  ipv4: string;
  hostname: string;
  certPath: string;
  keyPath: string;
}

export function discoverTailscaleEnv(opts: { certDir: string }): TailscaleEnv {
  const ipv4 = execFileSync('tailscale', ['ip', '--4'], { encoding: 'utf8' }).trim();
  if (!/^100\./.test(ipv4)) {
    throw new Error(`unexpected tailscale ip output: ${ipv4}`);
  }

  const statusJson = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  const status = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
  const dns = status.Self?.DNSName ?? '';
  const hostname = dns.replace(/\.$/, '');
  if (!hostname.endsWith('.ts.net')) {
    throw new Error(`unexpected tailscale DNS name: ${dns}`);
  }

  const certPath = `${opts.certDir}/${hostname}.crt`;
  const keyPath = `${opts.certDir}/${hostname}.key`;
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(
      `tailscale cert files not found. Run: tailscale cert --cert-file=${certPath} --key-file=${keyPath} ${hostname}`,
    );
  }
  readFileSync(certPath);
  readFileSync(keyPath);

  return { ipv4, hostname, certPath, keyPath };
}
