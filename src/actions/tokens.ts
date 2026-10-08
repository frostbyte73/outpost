// Comparison between versions of one file, not a billing number — chars/4 is close enough.
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
