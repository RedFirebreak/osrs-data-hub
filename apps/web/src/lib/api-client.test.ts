import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NO_RESPONSE,
  SESSION_ENDED_MESSAGE,
  UNREACHABLE_MESSAGE,
  apiErrorDetails,
  apiErrorMessage,
  failureMessage,
  fieldErrorsFrom,
  refreshesPage,
  sendJson,
} from './api-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(answer: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('sendJson', () => {
  it('sends a same-origin JSON request and returns the status and the parsed body', async () => {
    const fetchMock = stubFetch(Response.json({ key: 'ohub_x_y' }, { status: 201 }));
    const result = await sendJson('/api/app/api-keys', { method: 'POST', json: { name: 'Home' } });
    expect(result).toEqual({ ok: true, status: 201, body: { key: 'ohub_x_y' } });
    expect(fetchMock).toHaveBeenCalledWith('/api/app/api-keys', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"Home"}',
    });
  });

  it('is a GET without a body or a content type by default', async () => {
    const fetchMock = stubFetch(Response.json({ members: [] }));
    await sendJson('/api/app/members');
    expect(fetchMock).toHaveBeenCalledWith('/api/app/members', {
      method: 'GET',
      credentials: 'same-origin',
      headers: undefined,
      body: undefined,
    });
  });

  it('returns a failed answer with its error body instead of throwing', async () => {
    const body = { error: { code: 'invalid_request', message: 'The request is invalid.' } };
    stubFetch(Response.json(body, { status: 400 }));
    expect(await sendJson('/x', { method: 'DELETE' })).toEqual({ ok: false, status: 400, body });
  });

  it('gives a null body when the answer has none or it is not JSON', async () => {
    stubFetch(new Response(null, { status: 204 }));
    expect(await sendJson('/x')).toEqual({ ok: true, status: 204, body: null });
    stubFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await sendJson('/x')).toEqual({ ok: false, status: 502, body: null });
  });

  it('reports a request without an answer as NO_RESPONSE', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    expect(await sendJson('/x')).toEqual({ ok: false, status: NO_RESPONSE, body: null });
  });
});

describe('apiErrorMessage and apiErrorDetails', () => {
  it('reads the message of an API error body', () => {
    expect(apiErrorMessage({ error: { code: 'x', message: 'Nope.' } }, 'fallback')).toBe('Nope.');
    expect(apiErrorMessage(null, 'fallback')).toBe('fallback');
    expect(apiErrorMessage({ error: 'x' }, 'fallback')).toBe('fallback');
    expect(apiErrorMessage({ error: { message: 42 } }, 'fallback')).toBe('fallback');
    expect(apiErrorMessage({ error: { message: '  ' } }, 'fallback')).toBe('fallback');
  });

  it('reads the details of a 400 body', () => {
    const details = [{ path: 'name', message: 'too long' }];
    expect(apiErrorDetails({ error: { code: 'invalid_request', details } })).toBe(details);
    expect(apiErrorDetails({ error: 'x' })).toBeUndefined();
    expect(apiErrorDetails(null)).toBeUndefined();
  });
});

describe('fieldErrorsFrom', () => {
  it('keeps the first message per known field and ignores the rest', () => {
    expect(
      fieldErrorsFrom(
        [
          { path: 'name', message: 'too long' },
          { path: 'name', message: 'second' },
          { path: 'toastTypes.1', message: 'unknown event type' },
          { path: '', message: 'unknown key' },
          { path: 'other', message: 'not a field of this form' },
          { path: 7, message: 'no path' },
          'junk',
          null,
        ],
        ['name', 'toastTypes', 'timezone'],
      ),
    ).toEqual({ name: 'too long', toastTypes: 'unknown event type' });
  });

  it('is empty for anything that is not a list', () => {
    expect(fieldErrorsFrom(undefined, ['name'])).toEqual({});
    expect(fieldErrorsFrom({ path: 'name', message: 'x' }, ['name'])).toEqual({});
  });
});

describe('failureMessage', () => {
  const body = { error: { code: 'invalid', message: 'The hub says no.' } };

  it('has one text for no answer and one for an ended session, whatever the wording', () => {
    const failure = { fallback: 'fallback', notFound: 'gone', hubMessageFor: 'any' } as const;
    expect(failureMessage(NO_RESPONSE, null, failure)).toBe(UNREACHABLE_MESSAGE);
    expect(failureMessage(401, body, failure)).toBe(SESSION_ENDED_MESSAGE);
    expect(UNREACHABLE_MESSAGE).toBe(
      "Couldn't reach the hub. Check your connection and try again.",
    );
    expect(SESSION_ENDED_MESSAGE).toBe('Your session has ended. Sign in again.');
  });

  it("shows the hub's message for 400, 403 and 503 and the fallback otherwise", () => {
    for (const status of [400, 403, 503]) {
      expect(failureMessage(status, body, 'fallback')).toBe('The hub says no.');
      expect(failureMessage(status, null, 'fallback')).toBe('fallback');
    }
    for (const status of [200, 404, 409, 429, 500]) {
      expect(failureMessage(status, body, { fallback: 'fallback' })).toBe('fallback');
    }
  });

  it('takes the statuses whose message is shown from the options', () => {
    expect(failureMessage(400, body, { fallback: 'fallback', hubMessageFor: [403] })).toBe(
      'fallback',
    );
    expect(failureMessage(500, body, { fallback: 'fallback', hubMessageFor: 'any' })).toBe(
      'The hub says no.',
    );
    expect(failureMessage(200, null, { fallback: 'fallback', hubMessageFor: 'any' })).toBe(
      'fallback',
    );
  });

  it('uses the given texts for 404, 403 and 409', () => {
    const failure = { fallback: 'fallback', notFound: 'gone', forbidden: 'no', conflict: 'full' };
    expect(failureMessage(404, body, failure)).toBe('gone');
    expect(failureMessage(403, null, failure)).toBe('no');
    expect(failureMessage(403, body, failure)).toBe('The hub says no.');
    expect(failureMessage(409, null, failure)).toBe('full');
    expect(failureMessage(409, body, failure)).toBe('The hub says no.');
  });
});

describe('refreshesPage', () => {
  it('refreshes after a 401, and after a 404 only when asked', () => {
    expect(refreshesPage(401, 'fallback')).toBe(true);
    expect(refreshesPage(404, 'fallback')).toBe(false);
    expect(refreshesPage(404, { fallback: 'fallback' })).toBe(false);
    expect(refreshesPage(404, { fallback: 'fallback', refreshOnNotFound: true })).toBe(true);
    expect(refreshesPage(NO_RESPONSE, { fallback: 'fallback', refreshOnNotFound: true })).toBe(
      false,
    );
    expect(refreshesPage(500, { fallback: 'fallback', refreshOnNotFound: true })).toBe(false);
  });
});
