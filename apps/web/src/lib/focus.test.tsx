/**
 * The focus helpers against a few fake elements (the web tests run in node, without a DOM). How the
 * dialogs use them is checked in the browser (e2e/wizard.spec.ts: focus after revoking a device).
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  focusIsLost,
  headingOfSection,
  moveFocus,
  useFocusReturn,
  type FocusReturn,
} from './focus';

class FakeDoc {
  activeElement: FakeEl | null = null;
  readonly body = new FakeEl(this, 'body');
  readonly byId = new Map<string, FakeEl>();

  getElementById(id: string): FakeEl | null {
    return this.byId.get(id) ?? null;
  }
}

class FakeEl {
  isConnected = true;
  disabled = false;
  parentElement: FakeEl | null = null;
  readonly attrs = new Map<string, string>();
  private readonly blurListeners: (() => void)[] = [];

  constructor(
    readonly ownerDocument: FakeDoc,
    readonly tag: string,
    readonly focusableByDefault = false,
  ) {}

  get tabIndex(): number {
    const attr = this.attrs.get('tabindex');
    if (attr !== undefined) return Number(attr);
    return this.focusableByDefault ? 0 : -1;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  addEventListener(type: string, listener: () => void): void {
    if (type === 'blur') this.blurListeners.push(listener);
  }

  /** Like a browser: any tabindex (even -1) makes an element focusable from script. */
  focus(): void {
    const focusable = this.focusableByDefault || this.attrs.has('tabindex');
    if (this.disabled || !this.isConnected || !focusable) return;
    const previous = this.ownerDocument.activeElement;
    if (previous && previous !== this) previous.blur();
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    for (const l of this.blurListeners.splice(0)) l();
  }

  closest(selector: string): FakeEl | null {
    if (selector !== '[aria-labelledby]') throw new Error(`unsupported selector ${selector}`);
    if (this.attrs.has('aria-labelledby')) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  /** Appends a child element; `id` registers it with the document. */
  add(tag: string, opts: { id?: string; focusable?: boolean } = {}): FakeEl {
    const child = new FakeEl(this.ownerDocument, tag, opts.focusable);
    child.parentElement = this;
    if (opts.id) {
      child.attrs.set('id', opts.id);
      this.ownerDocument.byId.set(opts.id, child);
    }
    return child;
  }
}

const el = (e: FakeEl | null) => e as unknown as HTMLElement;

/** <section aria-labelledby="devices"><h2 id="devices"/><ul><li><button/></li></ul></section> */
function page() {
  const doc = new FakeDoc();
  const section = doc.body.add('section');
  section.setAttribute('aria-labelledby', 'devices extra');
  const heading = section.add('h2', { id: 'devices' });
  const button = section.add('ul').add('li').add('button', { focusable: true });
  return { doc, section, heading, button };
}

describe('headingOfSection', () => {
  it('is the element named by the nearest aria-labelledby around the control (its first id)', () => {
    const { heading, button } = page();
    expect(headingOfSection(el(button) as unknown as Element)).toBe(heading);
  });

  it('is null outside any labelled section, or when the heading is missing', () => {
    const doc = new FakeDoc();
    expect(
      headingOfSection(el(doc.body.add('div').add('button')) as unknown as Element),
    ).toBeNull();
    const { section, button } = page();
    section.setAttribute('aria-labelledby', 'nope');
    expect(headingOfSection(el(button) as unknown as Element)).toBeNull();
    expect(headingOfSection(null)).toBeNull();
  });
});

describe('moveFocus', () => {
  it('focuses a heading through a temporary tabindex="-1", removed once it loses the focus', () => {
    const { doc, heading, button } = page();
    expect(moveFocus(el(heading))).toBe(true);
    expect(doc.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    button.focus();
    expect(heading.hasAttribute('tabindex')).toBe(false);
  });

  it('skips targets that are gone, disabled or missing, and resolves functions late', () => {
    const { doc, heading, button } = page();
    const gone = doc.body.add('button', { focusable: true });
    gone.isConnected = false;
    button.disabled = true;
    let resolved = 0;
    const late = () => {
      resolved += 1;
      return el(heading);
    };
    expect(moveFocus(null, el(gone), el(button), late)).toBe(true);
    expect(doc.activeElement).toBe(heading);
    expect(resolved).toBe(1);
    expect(button.hasAttribute('tabindex')).toBe(false);
  });

  it('is false (and leaves no tabindex behind) when nothing can take the focus', () => {
    const { heading } = page();
    heading.isConnected = false;
    expect(moveFocus(el(heading), undefined, () => null)).toBe(false);
    expect(heading.hasAttribute('tabindex')).toBe(false);
  });
});

describe('focusIsLost', () => {
  it('is true on <body>, on nothing and on a removed element; false on a control', () => {
    const { doc, button } = page();
    const d = doc as unknown as Document;
    doc.activeElement = doc.body;
    expect(focusIsLost(d)).toBe(true);
    doc.activeElement = null;
    expect(focusIsLost(d)).toBe(true);
    button.focus();
    expect(focusIsLost(d)).toBe(false);
    button.isConnected = false;
    expect(focusIsLost(d)).toBe(true);
  });
});

describe('useFocusReturn', () => {
  function hook(): FocusReturn {
    let api: FocusReturn | undefined;
    function Probe() {
      api = useFocusReturn();
      return null;
    }
    renderToString(<Probe />);
    if (!api) throw new Error('not rendered');
    return api;
  }

  function closeEvent() {
    let prevented = false;
    return {
      event: { preventDefault: () => void (prevented = true) } as unknown as Event,
      prevented: () => prevented,
    };
  }

  it('leaves the close to Radix until set(), then moves the focus there once', () => {
    const { doc, heading } = page();
    const focusReturn = hook();
    const first = closeEvent();
    focusReturn.onCloseAutoFocus(first.event);
    expect(first.prevented()).toBe(false);

    focusReturn.set(el(heading));
    const second = closeEvent();
    focusReturn.onCloseAutoFocus(second.event);
    expect(second.prevented()).toBe(true);
    expect(doc.activeElement).toBe(heading);

    const third = closeEvent();
    focusReturn.onCloseAutoFocus(third.event);
    expect(third.prevented()).toBe(false);
  });

  it("keeps Radix's default when no target can take the focus", () => {
    const { heading } = page();
    heading.isConnected = false;
    const focusReturn = hook();
    focusReturn.set(el(heading));
    const close = closeEvent();
    focusReturn.onCloseAutoFocus(close.event);
    expect(close.prevented()).toBe(false);
  });
});
