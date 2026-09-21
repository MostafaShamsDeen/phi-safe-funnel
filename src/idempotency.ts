/**
 * Send-once, keyed on event_id.
 *
 * Meta deduplicates on event_id at their end, so a double send is usually
 * survivable. That is not a reason to send twice. Remote deduplication is a
 * safety net owned by someone else, and it only holds inside their matching
 * window; a retry that fires an hour later because a queue replayed is our bug,
 * and it is cheaper to not make it than to rely on a vendor to absorb it.
 *
 * The in-memory implementation is honest about what it is: correct for a single
 * process, and wrong the moment there are two of them. A real deployment swaps
 * in Redis or a unique index on a table, which is why this is an interface
 * rather than a Set.
 */

export interface SeenStore {
  has(eventId: string): Promise<boolean>;
  add(eventId: string): Promise<void>;
}

export function memoryStore(ttlMs = 24 * 60 * 60 * 1000): SeenStore {
  const seen = new Map<string, number>();

  const sweep = () => {
    const cutoff = Date.now() - ttlMs;
    for (const [id, at] of seen) if (at < cutoff) seen.delete(id);
  };

  return {
    async has(eventId) {
      sweep();
      return seen.has(eventId);
    },
    async add(eventId) {
      seen.set(eventId, Date.now());
    },
  };
}
