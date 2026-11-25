import type { CanonicalItem, SubagentInfo, TranscriptProject, TranscriptReader } from './types.js';
import type { JsonlTranscripts } from './jsonl-transcripts.js';

// Every runtime's history behind one reader; a new cwd's history dir is the primary runtime's.
export class CompositeTranscripts implements TranscriptReader {
  constructor(
    private readonly primary: TranscriptReader,
    private readonly others: { root: string; reader: TranscriptReader }[],
    private readonly jsonl?: JsonlTranscripts,
  ) {}

  scanProjectDirs(knownWorktreePaths: ReadonlySet<string>): TranscriptProject[] {
    return [this.primary, ...this.others.map((o) => o.reader)].flatMap((r) => r.scanProjectDirs(knownWorktreePaths));
  }

  projectDirFor(cwd: string): string {
    return this.primary.projectDirFor(cwd);
  }

  locateTranscript(id: string): string | undefined {
    return this.primary.locateTranscript?.(id);
  }

  readItems(projectDir: string, id: string, seedTokens?: readonly string[], forHandoff?: boolean): CanonicalItem[] {
    return this.readerFor(projectDir).readItems(projectDir, id, seedTokens, forHandoff);
  }

  readSubagents(projectDir: string, id: string): SubagentInfo[] {
    return this.readerFor(projectDir).readSubagents(projectDir, id);
  }

  deleteTranscript(projectDir: string, id: string): boolean {
    return this.readerFor(projectDir).deleteTranscript(projectDir, id);
  }

  private readerFor(projectDir: string): TranscriptReader {
    return this.others.find((o) => projectDir.startsWith(`${o.root}/`))?.reader
      ?? (this.jsonl && projectDir.startsWith(`${this.jsonl.root}/`) ? this.jsonl : this.primary);
  }
}
