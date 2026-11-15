import { authenticatedFetch } from './auth';
import { assertDataConsent } from './consent';
import { MAX_PDF_BYTES, readLimited } from '../../../agentic-pdf-runner/policy';
export const PREVIEW_URL = 'https://fp0et9oqqbr0kamofkwoe-agentic-pdf-runner.rork.live';
export const PUBLISHED_URL = 'https://agentic-pdf-runner.rork.app';
export function runnerBase() { return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname.endsWith('.rork.live') || window.parent !== window ? PREVIEW_URL : PUBLISHED_URL; }
export interface PdfPointRect { x: number; y: number; width: number; maxWidth?: number; height: number; fontSize: number; isBold?: boolean; isItalic?: boolean; isSerif?: boolean; paperBg?: [number, number, number]; inkRgb?: [number, number, number] }
export interface ApprovedEditOperation { id: string; kind?: 'text' | 'clone_page' | 'delete_page' | 'rotate_page'; page: number; find: string; replace: string; rotateDegrees?: number; plainSummary: string; bbox?: [number, number, number, number]; pdfRect?: PdfPointRect }
export interface PageTextSnapshot { page: number; lines: string[] }
export interface InitRunPayload { documentName: string; apiBase: string; templateKey?: string; templateTargets?: string[]; userRequests: string[]; operations: ApprovedEditOperation[]; pageTexts?: PageTextSnapshot[]; email?: string; returnUrl?: string; totalPages?: number }
export type RunPhase = 'planning' | 'editing' | 'verifying' | 'review' | 'done' | 'error' | 'cancelled';
export interface PublicRunStatus {
  runId: string; status: 'queued' | 'running' | 'review' | 'done' | 'error' | 'cancelled'; phase: RunPhase; overallPct: number;
  bars: { planning: number; editing: number; verifying: number }; message: string; documentName: string; outFileName: string;
  totalPages: number; activePage: number; activeRegion: [number, number, number, number] | null; userRequests: string[];
  email: string; emailStatus: 'none' | 'queued' | 'sent' | 'pending_provider' | 'failed'; emailNote: string; emailDeliveryConfigured: boolean;
  downloadReady: boolean; errorText?: string; updatedAt: number; storageBytes?: number; artifactVersion?: number;
  verificationStatus?: 'pending' | 'needs_review';
  requiresCandidateApproval?: boolean; candidateHash?: string; candidateReady?: boolean; approvedAt?: number;
}
export interface RunnerHealth { ok: boolean; emailDeliveryConfigured?: boolean }
export async function runnerRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const sharing = init.method === 'POST' && (path === '/plan' || path === '/runs' || /\/(source|start|approve)$/.test(path) || (path.endsWith('/email') && typeof init.body === 'string' && Boolean((JSON.parse(init.body) as { email?: string }).email)));
  const response = await authenticatedFetch(`${runnerBase()}${path}`, init, sharing ? assertDataConsent : undefined);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body ? String(body.error) : `Studio request failed (${response.status}).`);
  return body as T;
}
export function getStudioAccess() { return runnerRequest<{ userId: string | null; allowed: boolean; publicAccess?: boolean; configured: boolean }>('/access'); }
export function listRuns() { return runnerRequest<{ runs: PublicRunStatus[] }>('/runs'); }
export function deleteRun(id: string) { return runnerRequest<{ ok: boolean }>(`/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export async function checkRunnerHealth(signal?: AbortSignal): Promise<RunnerHealth | null> {
  try { return await runnerRequest<RunnerHealth>('/health', { signal }); } catch { return null; }
}
export function createBackgroundRun(payload: InitRunPayload) {
  assertDataConsent();
  return runnerRequest<PublicRunStatus>('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
export function uploadRunSourcePdf(id: string, bytes: Uint8Array) {
  assertDataConsent();
  return runnerRequest<{ ok: boolean }>(`/runs/${encodeURIComponent(id)}/source`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }) });
}
export function startBackgroundRun(id: string) { assertDataConsent(); return runnerRequest<PublicRunStatus>(`/runs/${encodeURIComponent(id)}/start`, { method: 'POST' }); }
export function approveRunCandidate(id: string, candidateHash: string, artifactVersion: number) {
  assertDataConsent();
  return runnerRequest<PublicRunStatus>(`/runs/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateHash, artifactVersion }) });
}
export function getBackgroundRunStatus(id: string, signal?: AbortSignal) { return runnerRequest<PublicRunStatus>(`/runs/${encodeURIComponent(id)}`, { signal }); }
export function updateRunNotificationEmail(id: string, email: string, returnUrl: string) {
  if (email) assertDataConsent();
  return runnerRequest<PublicRunStatus>(`/runs/${encodeURIComponent(id)}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, returnUrl }) });
}
export function cancelBackgroundRun(id: string) { return runnerRequest<PublicRunStatus>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); }
export function getRunPdfDownloadUrl(id: string) { return `${runnerBase()}/runs/${encodeURIComponent(id)}/pdf`; }
export async function fetchRunPdf(id: string, slot: 'pdf' | 'source' | 'working' | 'candidate', signal?: AbortSignal): Promise<{ bytes: Uint8Array; filename?: string }> {
  const response = await authenticatedFetch(`${runnerBase()}/runs/${encodeURIComponent(id)}/${slot}`, { signal });
  if (!response.ok) { const error = await response.json().catch(() => ({})) as { error?: string }; throw new Error(error.error || 'The PDF could not be loaded. Please retry.'); }
  const disposition = response.headers.get('Content-Disposition') || '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1];
  const bytes = await readLimited(response.body, MAX_PDF_BYTES); if (bytes.length < 8) throw new Error('The PDF response was empty.');
  return { bytes, filename };
}
export function fetchRunFinalPdfBytes(id: string, signal?: AbortSignal) { return fetchRunPdf(id, 'pdf', signal); }
