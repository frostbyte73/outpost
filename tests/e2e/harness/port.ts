import { createServer } from 'node:net';

// Asks the OS for an ephemeral port by binding to :0, then immediately closes the
// listener and returns the port. There's a window where another process could grab
// it before the daemon binds; for serial test runs this is fine.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || addr === null) {
        reject(new Error('no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}
