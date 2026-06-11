import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

export interface TestTls {
  certPath: string;
  keyPath: string;
}

// Generates a self-signed cert+key valid for the given host, writes them to dir,
// and returns the paths. The cert is short-lived (1 day) since it's only for tests.
export function selfSignedCert(dir: string, host: string): TestTls {
  const attrs = [{ name: 'commonName', value: host }];
  const pems = selfsigned.generate(attrs, {
    days: 1,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0' },
        { type: 2, value: host },
      ],
    }],
  });
  const certPath = join(dir, 'test.crt');
  const keyPath = join(dir, 'test.key');
  writeFileSync(certPath, pems.cert);
  writeFileSync(keyPath, pems.private);
  return { certPath, keyPath };
}
