import { describe, expect, it } from 'vitest';
import { mergeRunStatus } from './run-state';
import type { PublicRunStatus } from './backend';
const status = (overrides: Partial<PublicRunStatus> = {}) => ({ runId: 'synthetic-id', status: 'running', updatedAt: 10, ...overrides } as PublicRunStatus);
describe('Run response ordering', () => {
  it('does not revive a cancelled run from an in-flight poll', () => {
    const stopped = status({ status: 'cancelled' }); expect(mergeRunStatus(stopped, status({ updatedAt: 11 }))).toBe(stopped);
  });
  it('ignores old notification and progress snapshots', () => {
    const latest = status({ email: '', emailNote: 'Removed' }); expect(mergeRunStatus(latest, status({ updatedAt: 9, email: 'old@example.test' }))).toBe(latest);
  });
  it('never reopens a closed or different run', () => {
    expect(mergeRunStatus(null, status())).toBeNull(); const current = status(); expect(mergeRunStatus(current, status({ runId: 'another' }))).toBe(current);
  });
  it('keeps a review candidate frozen against running snapshots but accepts approval or cancellation', () => {
    const review = status({ status: 'review' });
    expect(mergeRunStatus(review, status({ updatedAt: 11 }))).toBe(review);
    const done = status({ status: 'done', updatedAt: 11 }); expect(mergeRunStatus(review, done)).toBe(done);
    const stopped = status({ status: 'cancelled', updatedAt: 12 }); expect(mergeRunStatus(review, stopped)).toBe(stopped);
    expect(mergeRunStatus(stopped, done)).toBe(stopped);
  });
  it('accepts newer same-run progress and terminal notification updates', () => {
    const done = status({ status: 'done' }); const next = status({ status: 'done', updatedAt: 11, emailStatus: 'sent' }); expect(mergeRunStatus(done, next)).toBe(next);
    expect(mergeRunStatus(status(), next)).toBe(next);
  });
});
