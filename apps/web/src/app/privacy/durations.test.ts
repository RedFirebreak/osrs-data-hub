import { describe, expect, it } from 'vitest';
import { formatDays, formatHours } from './durations';

describe('privacy durations', () => {
  it('formats days, adding years for whole years', () => {
    expect(formatDays(1)).toBe('1 day');
    expect(formatDays(30)).toBe('30 days');
    expect(formatDays(365)).toBe('365 days (1 year)');
    expect(formatDays(730)).toBe('730 days (2 years)');
    expect(formatDays(400)).toBe('400 days');
  });

  it('formats hours, adding days for whole days', () => {
    expect(formatHours(1)).toBe('1 hour');
    expect(formatHours(6)).toBe('6 hours');
    expect(formatHours(24)).toBe('24 hours (1 day)');
    expect(formatHours(72)).toBe('72 hours (3 days)');
  });
});
