/**
 * Bounded parallelism for the batch suggester.
 *
 * `Promise.all` over 25 cards would open 25 sockets to the provider and collect
 * a rate-limit error for most of them; a plain loop takes 25× one round-trip.
 * Three workers is the compromise the batch action runs at.
 */

export const DEFAULT_CONCURRENCY = 3;

/**
 * Run `fn` over `items` with at most `limit` in flight, results in input order.
 *
 * `fn` is expected to settle — the batch action catches per-card failures and
 * returns them as rows, so one bad card does not abandon the other 24. A
 * rejection here still rejects the whole map, deliberately: that means a bug,
 * not a provider hiccup.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
