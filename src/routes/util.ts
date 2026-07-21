export function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function readJsonBody<T>(req: NodeJS.ReadableStream): Promise<T | null> {
  const body = await readBody(req);
  if (!body) return null;
  try { return JSON.parse(body) as T; } catch { return null; }
}
