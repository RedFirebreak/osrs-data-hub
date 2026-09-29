/**
 * Streaming JSON for the data export (D-79): a document is written as a sequence of text pieces
 * whose concatenation is one valid JSON document. Plain values are serialized whole; large arrays are
 * streamed page by page from keyset-paginated queries, so no table is ever held in memory at once.
 */

/** A field value produced as pieces of JSON text (an array streamed from the database, say). */
export class StreamedValue {
  constructor(readonly pieces: () => AsyncIterable<string>) {}
}

/** Marks a field value to be written as the JSON text pieces `pieces()` yields. */
export function streamed(pieces: () => AsyncIterable<string>): StreamedValue {
  return new StreamedValue(pieces);
}

/** An object field: a plain JSON value (undefined leaves the field out) or a streamed one. */
export type Field = readonly [key: string, value: unknown];

/**
 * A JSON object from `fields`, in order. Fields come from an (async) iterable, so a value that needs
 * a query is only read when the writer reaches it. Undefined values leave the field out, as
 * JSON.stringify does.
 */
export async function* jsonObject(
  fields: Iterable<Field> | AsyncIterable<Field>,
): AsyncGenerator<string> {
  let first = true;
  yield '{';
  for await (const [key, value] of fields) {
    if (value === undefined) continue;
    const head = `${first ? '' : ','}\n${JSON.stringify(key)}:`;
    first = false;
    if (value instanceof StreamedValue) {
      yield head;
      yield* value.pieces();
    } else {
      yield head + JSON.stringify(value);
    }
  }
  yield '\n}';
}

/** A JSON array of whole pages of rows: one piece per page, each row on its own line. */
export async function* jsonArray<Row>(
  pages: AsyncIterable<readonly Row[]>,
  toJson: (row: Row) => unknown,
): AsyncGenerator<string> {
  let first = true;
  yield '[';
  for await (const rows of pages) {
    if (rows.length === 0) continue;
    const text = rows.map((row) => JSON.stringify(toJson(row))).join(',\n');
    yield `${first ? '\n' : ',\n'}${text}`;
    first = false;
  }
  yield ']';
}

/** A JSON array whose elements are each written as a sequence of pieces (objects with streams). */
export async function* jsonElements<T>(
  items: Iterable<T>,
  element: (item: T) => AsyncIterable<string>,
): AsyncGenerator<string> {
  let first = true;
  yield '[';
  for (const item of items) {
    yield first ? '\n' : ',\n';
    first = false;
    yield* element(item);
  }
  yield ']';
}

/**
 * Keyset pagination: pages of at most `size` rows, each read after the last row of the previous one
 * (`read(null, size)` for the first). Stops after a short page. Each page is read only when the
 * consumer asks for it, so a slow download never holds more than one page.
 */
export async function* keysetPages<Row>(
  read: (after: Row | null, limit: number) => Promise<Row[]>,
  size: number,
): AsyncGenerator<Row[]> {
  let after: Row | null = null;
  for (;;) {
    const rows = await read(after, size);
    if (rows.length > 0) yield rows;
    const last = rows.at(-1);
    if (rows.length < size || last === undefined) return;
    after = last;
  }
}
