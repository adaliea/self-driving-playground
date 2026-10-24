import { describe, expect, it } from 'vitest';
import { parseHostMessage, parsePresentationState } from './protocol';

describe('presentation state', () => {
  it('keeps valid helper ids once each and drops anything else', () => {
    expect(parsePresentationState({ lockedHelpers: ['fastest-lane', 'fastest-lane', 'Bad Id', 7, 'lateral-velocity'] })).toEqual({
      lockedHelpers: ['fastest-lane', 'lateral-velocity'],
    });
  });

  it('rejects malformed state', () => {
    expect(parsePresentationState({})).toBeUndefined();
    expect(parsePresentationState({ lockedHelpers: Array.from({ length: 40 }, (_, index) => `id-${index}`) })).toBeUndefined();
    expect(parseHostMessage({ type: 'presentation', state: { lockedHelpers: 'clamp' } })).toBeUndefined();
  });

  it('parses a host presentation message', () => {
    expect(parseHostMessage({ type: 'presentation', state: { lockedHelpers: ['clamp'] } })).toEqual({
      type: 'presentation',
      state: { lockedHelpers: ['clamp'] },
    });
  });
});
