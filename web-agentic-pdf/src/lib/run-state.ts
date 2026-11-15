import type { PublicRunStatus } from './backend';

/** Ignore responses for closed runs, stale snapshots and terminal-state regressions. */
export function mergeRunStatus(current: PublicRunStatus | null, next: PublicRunStatus): PublicRunStatus | null {
  if (!current || current.runId !== next.runId) return current;
  if (next.updatedAt < current.updatedAt) return current;
  if (['done', 'error', 'cancelled'].includes(current.status) && next.status !== current.status) return current;
  if (current.status === 'review' && ['queued', 'running'].includes(next.status)) return current;
  return next;
}
