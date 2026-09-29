import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ErrorPage from './error';
import NotFound from './not-found';

describe('error page', () => {
  it('shows the digest for reporting but never the error message', () => {
    const error = Object.assign(new Error('relation "session" does not exist, token=abc'), {
      digest: '1234567890',
    });
    const html = renderToStaticMarkup(<ErrorPage error={error} retry={() => {}} />);
    expect(html).toContain('1234567890');
    expect(html).not.toContain('session');
    expect(html).not.toContain('token');
    expect(html).toMatch(/<h1[^>]*>Something went wrong<\/h1>/);
  });

  it('keeps the main landmark (role="alert" goes on its content, not on <main>)', () => {
    const html = renderToStaticMarkup(<ErrorPage error={new Error('x')} retry={() => {}} />);
    expect(html).toMatch(/<main id="main"(?![^>]*role=)[^>]*>/);
    expect(html).toContain('role="alert"');
  });
});

describe('not-found page', () => {
  it('has one h1 and a way back', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/);
    expect(html).toContain('href="/"');
  });
});
