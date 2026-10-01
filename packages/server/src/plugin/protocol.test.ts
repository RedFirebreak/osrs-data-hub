import { describe, expect, it } from 'vitest';
import { MAX_VERSION_TEXT, storedVersionText } from './protocol';

describe('storedVersionText', () => {
  it('keeps an ordinary version as sent, trimmed', () => {
    expect(storedVersionText('1.5')).toBe('1.5');
    expect(storedVersionText('  1.6-SNAPSHOT ')).toBe('1.6-SNAPSHOT');
    expect(storedVersionText('v1.5 (dev build)')).toBe('v1.5 (dev build)');
  });

  it('is null for a missing or blank header', () => {
    expect(storedVersionText(null)).toBeNull();
    expect(storedVersionText('')).toBeNull();
    expect(storedVersionText(' \t ')).toBeNull();
    expect(storedVersionText('\u0000\u001f\u007f\u009f')).toBeNull();
  });

  it('removes every control character (C0, DEL, C1), not only NUL', () => {
    expect(storedVersionText('1.5\u0000')).toBe('1.5');
    expect(storedVersionText('\u001b[31m1.5\u0007')).toBe('[31m1.5');
    expect(storedVersionText('1.5\r\nX-Injected: 1')).toBe('1.5X-Injected: 1');
    expect(storedVersionText('1\u007f.\u00855')).toBe('1.5');
    // Trimmed after the removal, so a space next to a removed character doesn't stay.
    expect(storedVersionText('\u0000 1.5 \u0000')).toBe('1.5');
  });

  it('cuts the text to MAX_VERSION_TEXT characters', () => {
    expect(MAX_VERSION_TEXT).toBe(32);
    expect(storedVersionText(`1.0${'x'.repeat(100)}`)).toBe(`1.0${'x'.repeat(29)}`);
    expect(storedVersionText(`${'\u0001'.repeat(40)}1.5`)).toBe('1.5');
  });
});
