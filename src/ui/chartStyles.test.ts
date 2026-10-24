import { describe, expect, it } from 'vitest';
import { assignSlots, slotStyle } from './chartStyles';

describe('selection-based line styles', () => {
  it('gives each selected key its own slot, keeping slots stable as the selection changes', () => {
    const first = assignSlots(['speed', 'actualMotor', 'actualSteering']);
    expect(first).toEqual({ speed: 0, actualMotor: 1, actualSteering: 2 });
    const removed = assignSlots(['speed', 'actualSteering'], first);
    expect(removed).toEqual({ speed: 0, actualSteering: 2 });
    expect(assignSlots(['speed', 'actualSteering', 'leadSpeed'], removed)).toEqual({ speed: 0, actualSteering: 2, leadSpeed: 1 });
  });

  it('keeps a slot for a selected key whose signal is temporarily unavailable', () => {
    const slots = assignSlots(['graph:a', 'graph:b']);
    // After a reset, graph:b is recorded before graph:a; both stay selected, so neither restyles.
    expect(assignSlots(['graph:a', 'graph:b'], slots)).toEqual({ 'graph:a': 0, 'graph:b': 1 });
  });

  it('never repeats a colour and dash pair in either mode for a large selection', () => {
    const styles = Array.from({ length: 56 }, (_, slot) => slotStyle(slot));
    expect(new Set(styles.slice(0, 49).map((style) => `${style.color}/${style.defaultPattern}`)).size).toBe(49);
    expect(new Set(styles.map((style) => `${style.colorblindColor}/${style.pattern}`)).size).toBe(56);
    // A small selection uses distinct colours with plain lines by default.
    expect(new Set(styles.slice(0, 7).map((style) => style.color)).size).toBe(7);
    expect(styles.slice(0, 7).every((style) => style.defaultPattern === 'solid')).toBe(true);
  });
});
