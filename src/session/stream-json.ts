export class LineParser {
  private buf = '';
  onLine: (obj: unknown) => void = () => {};
  onError: (raw: string, err: Error) => void = () => {};

  write(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        this.onLine(JSON.parse(line));
      } catch (e) {
        this.onError(line, e as Error);
      }
    }
  }
}
