import type { SessionInfo } from '../session-store.js';

export function partitionSessions(
  sessions: SessionInfo[],
  extraRevealed: number,
  nowMs: number,
): { visible: SessionInfo[]; hiddenRemaining: number };
