export interface CandidateSnapshot {
  status: string;
  deleted?: boolean;
  requiresCandidateApproval?: boolean;
  candidateHash?: string;
  artifactVersion: number;
  approvedAt?: number;
}

export async function hashPdf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Approval always names one immutable artifact, never merely a run. */
export function assertCandidateApproval(snapshot: CandidateSnapshot, body: unknown): 'approve' | 'already-approved' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Review and approve the loaded candidate PDF.');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !['candidateHash', 'artifactVersion'].includes(key)) ||
      typeof value.candidateHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.candidateHash) ||
      !Number.isSafeInteger(value.artifactVersion) || Number(value.artifactVersion) < 1) {
    throw new Error('Review and approve the loaded candidate PDF.');
  }
  if (snapshot.deleted || !snapshot.requiresCandidateApproval || !['review', 'done'].includes(snapshot.status)) {
    throw new Error('This candidate is not available for approval. Reopen the run to check its status.');
  }
  if (snapshot.candidateHash !== value.candidateHash || snapshot.artifactVersion !== value.artifactVersion) {
    throw new Error('The candidate differs from the PDF you reviewed. Reload it before approving.');
  }
  if (snapshot.status === 'done') {
    if (!snapshot.approvedAt) throw new Error('This run has no saved candidate approval.');
    return 'already-approved';
  }
  return 'approve';
}
