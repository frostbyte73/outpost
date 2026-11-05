import type { CanonicalItem, SubagentInfo, TranscriptProject, TranscriptReader } from './types.js';

// Every runtime's history behind one reader; a new cwd's history dir is the primary runtime's.
export class CompositeTranscripts implements TranscriptReader {
  constructor(
    private readonly primary: TranscriptReader,
    private readonly others: { root: string; reader: TranscriptReader }[],
  ) {}

  scanProjectDirs(knownWorktreePaths: ReadonlySet<string>): TranscriptProject[] {
    return [this.primary, ...this.others.map((o) => o.reader)].flatMap((r) => r.scanProjectDirs(knownWorktreePaths));
  }

  projectDirFor(cwd: string): string {
    return this.primary.projectDirFor(cwd);
  }

  readItems(projectDir: string, id: string): CanonicalItem[] {
    return this.readerFor(projectDir).readItems(projectDir, id);
  }

  readSubagents(projectDir: string, id: string): SubagentInfo[] {
    return this.readerFor(projectDir).readSubagents(projectDir, id);
  }

  deleteTranscript(projectDir: string, id: string): boolean {
    return this.readerFor(projectDir).deleteTranscript(projectDir, id);
  }

  private readerFor(projectDir: string): TranscriptReader {
    return this.others.find((o) => projectDir.startsWith(`${o.root}/`))?.reader ?? this.primary;
  }
}
