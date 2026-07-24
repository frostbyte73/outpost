import { describe, it, expect } from 'vitest';
import { actionNameForStep } from '../../src/work/engine.js';

describe('actionNameForStep', () => {
  const s = (state: string) => ({ type: 'open-pr', state } as any);
  it('speccing → code.spec', () => expect(actionNameForStep(s('speccing'))).toBe('code.spec'));
  it('planning → code.plan', () => expect(actionNameForStep(s('planning'))).toBe('code.plan'));
  it('implementing → code.implement', () => expect(actionNameForStep(s('implementing'))).toBe('code.implement'));
});
