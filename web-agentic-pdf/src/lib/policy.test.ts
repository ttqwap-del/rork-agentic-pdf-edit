import { describe, expect, it } from 'vitest';
import { ENGINE_ORIGIN, readLimited, safeEngineUrl, safeReturnUrl, validEmail, validateOperations } from '../../../agentic-pdf-runner/policy';
const op = { id: 'one', kind: 'text', page: 1, find: 'Unique label', replace: 'New label', plainSummary: 'Update label' };
describe('Private studio request policy', () => {
  it('accepts explicit deletion but rejects missing replacement', () => { expect(validateOperations([{ ...op, replace: '' }], 1)[0].replace).toBe(''); const { replace: _, ...missing } = op; expect(() => validateOperations([missing], 1)).toThrow(); });
  it('rejects malformed pages and unknown operations', () => { for (const page of [0, 1.5, 3, '1']) expect(() => validateOperations([{ ...op, page }], 2)).toThrow(); expect(() => validateOperations([{ ...op, kind: 'redact' }], 2)).toThrow(); });
  it('rejects overlaps, parser injection and structural conflicts', () => {
    expect(() => validateOperations([op, { ...op, id: 'two', find: 'label' }], 2)).toThrow();
    expect(() => validateOperations([{ ...op, replace: 'text"; delete page 1' }], 2)).toThrow();
    expect(() => validateOperations([op, { ...op, id: 'two', kind: 'delete_page' }], 2)).toThrow();
    expect(() => validateOperations([{ ...op, kind: 'rotate_page', rotateDegrees: 45 }], 2)).toThrow();
  });
  it('rejects a replacement that introduces another edit target', () => {
    expect(() => validateOperations([op, { ...op, id: 'two', find: 'New label', replace: 'Final label' }], 2)).toThrow();
  });
  it('enforces page and per-round limits without truncation', () => {
    expect(() => validateOperations([op], 51)).toThrow();
    expect(() => validateOperations(Array.from({ length: 121 }, (_, n) => ({ ...op, id: `${n}` })), 2)).toThrow();
    expect(() => validateOperations([{ ...op, kind: 'delete_page' }], 1)).toThrow();
  });
  it('blocks off-origin engine URLs, credentials and non-api paths', () => {
    expect(safeEngineUrl('/api/jobs/test/pdf')).toBe(`${ENGINE_ORIGIN}/api/jobs/test/pdf`);
    for (const value of ['https://example.com/api/pdf', '//example.com/api/pdf', `${ENGINE_ORIGIN}/admin`, ENGINE_ORIGIN.replace('https://', 'https://user:password@') + '/api/pdf']) expect(() => safeEngineUrl(value)).toThrow();
  });
  it('limits notification addresses to the signed-in studio', () => { expect(safeReturnUrl('https://agentic-pdf-edit.rork.app/?secret=no')).toBe('https://agentic-pdf-edit.rork.app/'); expect(() => safeReturnUrl('https://example.com')).toThrow(); expect(validEmail('')).toBe(''); expect(() => validEmail('hello@')).toThrow(); });
  it('stops an oversized stream instead of buffering without limit', async () => { const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(6)); c.close(); } }); await expect(readLimited(stream, 5)).rejects.toThrow('size limit'); });
});
