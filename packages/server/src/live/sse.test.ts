import { describe, expect, it } from 'vitest';
import { formatSse, SSE_HEARTBEAT, SSE_RETRY_MS, sseHello } from './sse';
import { parseSse } from './test-support';

describe('formatSse', () => {
  it('writes id, event and one data line of JSON, ending with a blank line', () => {
    expect(formatSse({ event: 'event', id: 42, data: { a: 1 } })).toBe(
      'id: 42\nevent: event\ndata: {"a":1}\n\n',
    );
  });

  it('omits the id when there is none, or when it is not a safe integer', () => {
    expect(formatSse({ event: 'resync', data: {} })).toBe('event: resync\ndata: {}\n\n');
    expect(formatSse({ event: 'presence', id: Number.NaN, data: 1 })).toBe(
      'event: presence\ndata: 1\n\n',
    );
    expect(formatSse({ event: 'presence', id: 1.5, data: 1 })).not.toContain('id:');
  });

  it('sends undefined data as null', () => {
    expect(formatSse({ event: 'resync', data: undefined })).toBe('event: resync\ndata: null\n\n');
  });

  it('keeps newlines inside strings escaped, so a value cannot inject SSE fields', () => {
    const evil = 'line1\nline2\r\nid: 999\n\nevent: resync\ndata: {}';
    const text = formatSse({ event: 'event', id: 7, data: { text: evil } });
    expect(text.split('\n')).toHaveLength(5); // id, event, data, '', ''
    const parsed = parseSse(text);
    expect(parsed).toEqual([{ id: '7', event: 'event', data: { text: evil } }]);
  });

  it('round-trips unicode, including the JS line separators', () => {
    const data = { name: 'Zézima    😀' };
    expect(parseSse(formatSse({ event: 'event', data }))[0]?.data).toEqual(data);
  });
});

describe('sseHello and heartbeat', () => {
  it('starts with the retry hint and a comment', () => {
    expect(SSE_RETRY_MS).toBe(5000);
    expect(sseHello()).toBe('retry: 5000\n: connected\n\n');
  });

  it('the heartbeat is a comment (no message for EventSource)', () => {
    expect(SSE_HEARTBEAT).toBe(': ping\n\n');
    expect(parseSse(sseHello() + SSE_HEARTBEAT)).toEqual([]);
  });
});
