import { ENGINE_ORIGIN, MAX_PDF_BYTES, readLimited, safeEngineUrl } from '../../agentic-pdf-runner/policy';
export const DEFAULT_API_BASE = ENGINE_ORIGIN;

export const MAX_INSTRUCTIONS_PER_JOB = 10;

export interface HealthInfo {
  ok: boolean;
  jobs_running?: number;
  jobs_queued?: number;
  jobs_recent?: number;
  storage: string;
  llm: string;
  model: string;
  dpi: number;
  max_upload_mb: number;
  max_pages: number;
  retention_hours: number;
  concurrency: number;
}

export interface TemplateItem {
  key: string;
  name: string;
  note?: string;
  ok: boolean;
  pages: number;
  size_mb: number;
  table_edit: boolean;
  text_layer: boolean;
  text_edit: boolean;
  targets_available: number;
  structural: boolean;
  targets?: string[];
  error?: string;
}

export interface EditResult {
  n?: number;
  instruction: string;
  source: string;
  status: string;
  reason?: string;
  find?: string | null;
  replace?: string | null;
}

export interface JobEvidence {
  job_id: string;
  source: string;
  source_sha256: string;
  out_sha256: string;
  pages: number;
  targets_considered?: number;
  instructions: string[];
  results: EditResult[];
  duration_s: number;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'refused' | 'error' | 'aborted';

export interface JobSource {
  kind: 'template' | 'upload';
  key?: string;
  upload_id?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  stage?: string;
  pct?: number;
  eta_s?: number | null;
  source?: JobSource | null;
  instructions?: string[];
  edits_total?: number;
  edits_done?: number;
  edit_results?: EditResult[];
  out_key?: string | null;
  out_name?: string | null;
  download_url?: string | null;
  evidence?: JobEvidence | null;
  error?: string | null;
}

export interface CreateJobResponse {
  job_id: string;
  pct?: number;
  eta_s?: number | null;
  instructions?: string[];
}

export class ApiError extends Error {
  status: number;
  resubmit: boolean;

  constructor(message: string, status: number, resubmit = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.resubmit = resubmit;
  }
}

function extractDetail(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    if (typeof rec.error === 'string' && rec.error.trim()) return rec.error.trim();
    if (typeof rec.detail === 'string' && rec.detail.trim()) return rec.detail.trim();
    if (Array.isArray(rec.detail) && rec.detail.length > 0) {
      const first = rec.detail[0] as Record<string, unknown>;
      if (typeof first?.msg === 'string') return first.msg;
    }
  }
  return fallback;
}

async function requestJson<T>(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: T }> {
  if (base !== ENGINE_ORIGIN) throw new Error('Unapproved processing service.');
  const response = await fetch(`${base}${path}`, {
    ...init,
    redirect: 'error',
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    // CORS_ALLOW_CREDENTIALS=0 on pdfsurgeon: never send cookies.
    credentials: 'omit',
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const detail = extractDetail(parsed, response.statusText || `HTTP ${response.status}`);
    const status = response.status;
    if (status === 413) {
      throw new ApiError(detail || 'PDF exceeds the 25 MB upload limit.', status, false);
    }
    if (status === 429) {
      throw new ApiError(
        detail || 'Rate limit reached (30 jobs/h or 60 uploads/h per IP). Please wait briefly and try again.',
        status,
        true,
      );
    }
    if (status === 410) {
      throw new ApiError(
        detail || 'This output expired (outputs are kept for 24 hours). Resubmit to regenerate it.',
        status,
        true,
      );
    }
    if (status === 503) {
      throw new ApiError(
        detail || 'Engine queue is temporarily full. Retry in a moment.',
        status,
        true,
      );
    }
    if (status === 404) {
      throw new ApiError(detail || 'Record not found or expired on the server.', status, true);
    }
    throw new ApiError(detail, status, false);
  }

  return { status: response.status, data: parsed as T };
}

export async function fetchHealth(base: string, signal?: AbortSignal): Promise<HealthInfo> {
  const { data } = await requestJson<HealthInfo>(base, '/healthz', { method: 'GET', signal });
  return data;
}

export async function fetchTemplates(base: string, signal?: AbortSignal): Promise<TemplateItem[]> {
  const { data } = await requestJson<{ templates: TemplateItem[] }>(base, '/api/templates', {
    method: 'GET',
    signal,
  });
  return Array.isArray(data?.templates) ? data.templates : [];
}

export async function createJob(
  base: string,
  payload: { template?: string; upload_id?: string; instruction: string },
  signal?: AbortSignal,
): Promise<CreateJobResponse> {
  if (payload.upload_id) throw new Error('Private documents must use the authenticated studio runner.');
  const { data } = await requestJson<CreateJobResponse>(base, '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal,
  });
  return data;
}

export async function getJob(
  base: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<JobRecord> {
  try {
    const { data } = await requestJson<JobRecord>(
      base,
      `/api/jobs/${encodeURIComponent(jobId)}`,
      { method: 'GET', signal },
    );
    return data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(
        'Job record is no longer on the server (expired or service restarted). Resubmit to run it again.',
        404,
        true,
      );
    }
    throw err;
  }
}

export async function cancelJob(base: string, jobId: string): Promise<void> {
  try {
    await requestJson(base, `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
  } catch (err) {
    // 409 means the job already reached a terminal state.
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) return;
    throw err;
  }
}

export async function fetchJobEvidence(base: string, jobId: string): Promise<JobEvidence | null> {
  try {
    const { data } = await requestJson<JobEvidence>(
      base,
      `/api/jobs/${encodeURIComponent(jobId)}/evidence`,
      { method: 'GET' },
    );
    return data;
  } catch {
    return null;
  }
}

export async function fetchJobReport(base: string, jobId: string, n = 1): Promise<string> {
  try {
    const response = await fetch(
      `${base}/api/jobs/${encodeURIComponent(jobId)}/report?n=${n}`,
      { method: 'GET', credentials: 'omit' },
    );
    const text = await response.text();
    if (!response.ok) return text || `Report unavailable (${response.status})`;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  } catch {
    return 'Report could not be loaded.';
  }
}

export function resolveJobPdfUrl(base: string, job: Pick<JobRecord, 'id' | 'download_url'>): string {
  const raw = job.download_url || `/api/jobs/${encodeURIComponent(job.id)}/pdf`;
  const url = new URL(raw, `${base}/`);
  return safeEngineUrl(url.href);
}

export async function fetchPdfBytes(
  pdfUrl: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; filename?: string } | null> {
  try {
    const response = await fetch(safeEngineUrl(pdfUrl), {
      method: 'GET', credentials: 'omit', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";\r\n]+)"?/i);
    const filename = match?.[1] ? decodeURIComponent(match[1].trim()) : undefined;
    const bytes = await readLimited(response.body, MAX_PDF_BYTES);
    if (bytes.length < 8) return null;
    return { bytes, filename };
  } catch {
    // When switched to 302 presigned S3 URLs without bucket CORS, fetch() may fail
    // while browser navigation (<a href>) continues to work cleanly.
    return null;
  }
}

export function splitInstructions(raw: string): string[] {
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isServiceRestartError(message?: string | null, httpStatus?: number): boolean {
  if (httpStatus === 404) return true;
  if (!message) return false;
  return /service\s*restarted|restarted\s*before|container\s*restarted|worker\s*restarted|no\s*longer\s*on\s*the\s*server/i.test(
    message,
  );
}
