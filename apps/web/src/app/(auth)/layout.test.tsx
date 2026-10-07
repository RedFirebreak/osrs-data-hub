/** The sign-in pages' footer: where a visitor can check what this site is before signing in. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AuthLayout from './layout';

describe('sign-in layout', () => {
  it('links to the privacy page, the project site and the source, and says it is not Jagex', () => {
    const html = renderToStaticMarkup(
      <AuthLayout>
        <p>page</p>
      </AuthLayout>,
    );
    expect(html).toContain('<p>page</p>');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="https://scapekeeper.com"');
    expect(html).toContain('href="https://github.com/RedFirebreak/osrs-data-hub"');
    expect(html).toContain('Not affiliated with or endorsed by Jagex Ltd.');
  });
});
