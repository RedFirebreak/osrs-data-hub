/** Reading metric values in tests (createTestMetrics registries). */

interface Readable {
  get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }>;
}

/**
 * A counter's non-zero values keyed by one label; `{}` when nothing was recorded (known label values
 * start at 0, see initSeries).
 */
export async function countsBy(metric: Readable, label: string): Promise<Record<string, number>> {
  const { values } = await metric.get();
  return Object.fromEntries(
    values.filter((v) => v.value !== 0).map((v) => [String(v.labels[label]), v.value]),
  );
}

/** An unlabelled counter's (or gauge's) value. */
export async function valueOf(metric: Readable): Promise<number> {
  return (await metric.get()).values[0]?.value ?? 0;
}
