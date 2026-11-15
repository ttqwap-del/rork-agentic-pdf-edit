import { describe, expect, it } from 'vitest';
import { assertCandidateApproval, hashPdf, type CandidateSnapshot } from '../../../agentic-pdf-runner/candidate';
const hash = 'a'.repeat(64);
const state: CandidateSnapshot = { status: 'review', requiresCandidateApproval: true, candidateHash: hash, artifactVersion: 3 };
const approval = { candidateHash: hash, artifactVersion: 3 };
describe('Immutable candidate approval', () => {
  it('hashes the exact byte range with SHA-256', async () => {
    const bytes = new TextEncoder().encode('xabcx');
    expect(await hashPdf(bytes.subarray(1, 4))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashPdf(bytes)).not.toBe(await hashPdf(bytes.subarray(1, 4)));
  });
  it('accepts only the stored hash and artifact version', () => {
    expect(assertCandidateApproval(state, approval)).toBe('approve');
    expect(() => assertCandidateApproval(state, { ...approval, candidateHash: 'b'.repeat(64) })).toThrow('differs');
    expect(() => assertCandidateApproval(state, { ...approval, artifactVersion: 2 })).toThrow('differs');
  });
  it('rejects malformed or partial approvals rather than guessing', () => {
    for (const body of [null, [], {}, { ...approval, candidateHash: hash.toUpperCase() }, { ...approval, artifactVersion: '3' }, { ...approval, artifactVersion: 1.5 }, { ...approval, artifactVersion: 0 }, { ...approval, approved: true }]) {
      expect(() => assertCandidateApproval(state, body)).toThrow();
    }
  });
  it('does not promote pending, cancelled, errored, deleted or legacy runs', () => {
    for (const status of ['queued', 'running', 'cancelled', 'error']) expect(() => assertCandidateApproval({ ...state, status }, approval)).toThrow('not available');
    expect(() => assertCandidateApproval({ ...state, deleted: true }, approval)).toThrow('not available');
    expect(() => assertCandidateApproval({ ...state, requiresCandidateApproval: undefined }, approval)).toThrow('not available');
  });
  it('only treats the same previously recorded approval as idempotent', () => {
    expect(assertCandidateApproval({ ...state, status: 'done', approvedAt: 100 }, approval)).toBe('already-approved');
    expect(() => assertCandidateApproval({ ...state, status: 'done' }, approval)).toThrow('no saved');
    expect(() => assertCandidateApproval({ ...state, status: 'done', approvedAt: 100 }, { ...approval, artifactVersion: 4 })).toThrow('differs');
    expect(() => assertCandidateApproval({ ...state, status: 'done', approvedAt: 100, deleted: true }, approval)).toThrow('not available');
  });
});
