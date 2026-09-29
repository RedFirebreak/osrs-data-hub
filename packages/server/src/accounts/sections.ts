/**
 * The three states of every section of an account a read model returns (handoff §10):
 * - not visible: the viewer may not see the category; the object carries nothing else;
 * - not shared: visible, but the plugin never sent that section (its *_updated_at is null), shown as
 *   "not shared" rather than as empty (D-4);
 * - shared: the data, with when the hub last received it (a read model may coarsen that time for a
 *   viewer, see AccountPage).
 */
export type Section<T> =
  | { visible: false }
  | { visible: true; shared: false }
  | { visible: true; shared: true; updatedAt: string; data: T };

/**
 * Builds a Section. `build` runs only when the section is visible AND shared, so data of a category
 * the viewer can't see is never even computed, let alone returned.
 */
export function sectionOf<T>(
  visible: boolean,
  updatedAt: Date | null | undefined,
  build: () => T,
): Section<T> {
  if (!visible) return { visible: false };
  if (updatedAt === null || updatedAt === undefined) return { visible: true, shared: false };
  return { visible: true, shared: true, updatedAt: updatedAt.toISOString(), data: build() };
}

/** A shared section with its updatedAt passed through `restamp`; any other state is unchanged. */
export function restampSection<T>(section: Section<T>, restamp: (at: Date) => Date): Section<T> {
  if (!section.visible || !section.shared) return section;
  return { ...section, updatedAt: restamp(new Date(section.updatedAt)).toISOString() };
}

/** The latest of the given times (nulls ignored), or null when all are null. */
export function latestOf(...times: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const t of times) {
    if (t && (best === null || t.getTime() > best.getTime())) best = t;
  }
  return best;
}
