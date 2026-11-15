import { DurableObject } from 'cloudflare:workers';
import { assertCandidateApproval, hashPdf } from './candidate';
import { degrees, PDFDocument, PDFName } from 'pdf-lib';
import { ENGINE_ORIGIN, MAX_PDF_BYTES, MAX_PAGES, readJson, readLimited, safeEngineUrl, safeReturnUrl, validEmail, validateOperations, type Operation } from './policy';

export interface RunnerEnv {
  RUN_COORDINATOR: DurableObjectNamespace<RunCoordinator>;
  STUDIO_CATALOG: DurableObjectNamespace<StudioCatalog>;
  STUDIO_OWNER_USER_ID?: string;
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
}
export type ApprovedEditOperation = Operation;
export interface InitRunPayload { runId: string; documentName: string; operations: Operation[]; totalPages: number; userRequests: string[]; email?: string; returnUrl: string }
type Status = 'queued' | 'running' | 'review' | 'done' | 'error' | 'cancelled';
interface State {
  schemaVersion: 2; ownerUserId: string; runId: string; status: Status;
  phase: 'planning' | 'editing' | 'verifying' | 'review' | 'done' | 'error' | 'cancelled';
  revision: number; deleted?: boolean; sourceReady: boolean; artifactVersion: number;
  // Absent on pre-approval runs: never silently change already-persisted jobs.
  requiresCandidateApproval?: true; candidateHash?: string; approvedAt?: number;
  documentName: string; outFileName: string; originalPages: number; totalPages: number;
  operations: Operation[]; userRequests: string[]; cursor: number; structuralDone: boolean;
  activePage: number; message: string; errorText: string; returnUrl: string;
  job?: { id: string; startedAt: number; page: number; cursor: number };
  nextStepAt?: number; pendingSubmission?: boolean; createdAt: number; updatedAt: number;
}
interface EmailState { updatedAt?: number; email: string; version: number; status: 'none' | 'queued' | 'sent' | 'pending_provider' | 'failed'; note: string; attempts: number; nextAt: number; dispatching: boolean }
interface EngineJob { id: string; status: string; download_url?: string; error?: string; edit_results?: { status: string; find?: string; replace?: string }[] }
const CHUNK = 524_288;
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Bounded response reading and redirect rejection apply to every engine request.
async function engine(path: string, init: RequestInit = {}): Promise<Uint8Array> {
  const res = await fetch(safeEngineUrl(path), { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); throw new Error('Editing engine returned an unapproved redirect. Your saved source is unchanged.'); }
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Editing engine returned ${res.status}. Your saved source is unchanged.`); }
  return readLimited(res.body, MAX_PDF_BYTES);
}
async function engineJson<T>(path: string, init?: RequestInit): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await engine(path, init))) as T;
}
export async function inspectSupportedPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (bytes.length < 8 || bytes.length > MAX_PDF_BYTES || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('Choose a valid PDF up to 25 MB.');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (doc.getPageCount() < 1 || doc.getPageCount() > MAX_PAGES) throw new Error('Cloud editing supports 1–50 pages.');
  // Fail closed instead of silently losing document-level features or invalidating signatures.
  for (const key of ['AcroForm', 'Outlines', 'StructTreeRoot', 'Names', 'OpenAction', 'AA', 'Perms', 'OCProperties']) {
    if (doc.catalog.has(PDFName.of(key))) throw new Error(`This PDF contains ${key === 'AcroForm' ? 'forms or signatures' : 'advanced document features'} that cannot yet be preserved safely. Use a plain PDF copy.`);
  }
  for (const page of doc.getPages()) {
    if (page.node.Annots()?.size()) throw new Error('Annotated or linked PDFs are not yet supported for safe reconstruction.');
  }
  return doc;
}

export class RunCoordinator extends DurableObject<RunnerEnv> {
  private ticking = false;
  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS run_meta (id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pdf_chunks (slot TEXT NOT NULL, idx INTEGER NOT NULL, chunk BLOB NOT NULL, PRIMARY KEY(slot,idx))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS notification (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  }
  private state(): State | null {
    const row = this.ctx.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM run_meta WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.state_json) as State : null;
  }
  private put(state: State) {
    state.updatedAt = Math.max(Date.now(), (this.state()?.updatedAt || 0) + 1, (this.email().updatedAt || 0) + 1);
    this.ctx.storage.sql.exec('INSERT INTO run_meta VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json', JSON.stringify(state));
  }
  private current(snapshot: State): State {
    const s = this.state();
    if (!s || s.deleted || s.revision !== snapshot.revision || s.status !== snapshot.status) throw new Error('Run changed; stale work discarded.');
    return s;
  }
  private email(): EmailState {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM notification WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) as EmailState : { email: '', version: 0, status: 'none', note: '', attempts: 0, nextAt: 0, dispatching: false };
  }
  private putEmail(e: EmailState) {
    e.updatedAt = Math.max(Date.now(), (this.email().updatedAt || 0) + 1, (this.state()?.updatedAt || 0) + 1);
    this.ctx.storage.sql.exec('INSERT INTO notification VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(e));
  }
  private bytes(slot: string): Uint8Array | null {
    const rows = this.ctx.storage.sql.exec<{ chunk: ArrayBuffer }>('SELECT chunk FROM pdf_chunks WHERE slot=? ORDER BY idx', slot).toArray();
    if (!rows.length) return null;
    const chunks = rows.map(r => new Uint8Array(r.chunk)); const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
  }
  private putBytes(slot: string, bytes: Uint8Array) {
    if (bytes.length > MAX_PDF_BYTES) throw new Error('The reconstructed PDF exceeds 25 MB.');
    this.ctx.storage.sql.exec('DELETE FROM pdf_chunks WHERE slot=?', slot);
    for (let offset = 0; offset < bytes.length; offset += CHUNK) this.ctx.storage.sql.exec('INSERT INTO pdf_chunks VALUES(?,?,?)', slot, offset / CHUNK, bytes.slice(offset, offset + CHUNK));
  }
  private storageBytes(): number { return this.ctx.storage.sql.exec<{ size: number }>('SELECT COALESCE(SUM(length(chunk)),0) AS size FROM pdf_chunks').toArray()[0].size; }
  private commit(s: State, artifacts: Record<string, Uint8Array> = {}) {
    this.current(s);
    this.ctx.storage.transactionSync(() => { for (const [slot, bytes] of Object.entries(artifacts)) this.putBytes(slot, bytes); this.put(s); });
  }
  private status(s: State) {
    const email = this.email(); const edits = s.operations.filter(o => o.kind === 'text');
    const planning = s.sourceReady ? 100 : 0;
    const editing = s.structuralDone ? 100 : Math.round(s.cursor / Math.max(1, edits.length) * 90);
    const verifying = ['review', 'done'].includes(s.status) ? 100 : 0;
    return { runId: s.runId, status: s.status, phase: s.phase,
      overallPct: s.status === 'done' ? 100 : s.status === 'review' ? 95 : Math.round(planning * .15 + editing * .7),
      bars: { planning, editing, verifying }, message: s.message, documentName: s.documentName,
      outFileName: s.outFileName, totalPages: s.totalPages, activePage: s.activePage, activeRegion: null,
      userRequests: s.userRequests, email: email.email, emailStatus: email.status, emailNote: email.note,
      emailDeliveryConfigured: Boolean(this.env.RESEND_API_KEY && this.env.RESEND_FROM_EMAIL),
      downloadReady: s.status === 'done', errorText: s.errorText || undefined, updatedAt: Math.max(s.updatedAt, email.updatedAt || 0),
      storageBytes: this.storageBytes(), artifactVersion: s.artifactVersion,
      requiresCandidateApproval: Boolean(s.requiresCandidateApproval), candidateHash: s.candidateHash,
      candidateReady: Boolean(s.candidateHash && ['review', 'done'].includes(s.status)), approvedAt: s.approvedAt,
      verificationStatus: ['review', 'done'].includes(s.status) ? 'needs_review' : 'pending' };
  }
  override async fetch(request: Request): Promise<Response> {
    try {
      const userId = request.headers.get('X-Studio-Owner')?.trim();
      if (!userId) return response({ error: 'Studio session required.' }, 401);
      const path = new URL(request.url).pathname;
      if (path === '/init' && request.method === 'POST') {
        if (this.state()) return response({ error: 'This run already exists. Open it instead of replacing it.' }, 409);
        const body = await readJson(request);
        if (this.state()) return response({ error: 'Run already exists.' }, 409);
        const operations = validateOperations(body.operations, Number(body.totalPages));
        const email = validEmail(body.email); const returnUrl = safeReturnUrl(body.returnUrl);
        if (typeof body.documentName !== 'string' || !body.documentName.trim() || body.documentName.length > 200) throw new Error('Invalid document name.');
        if (!Array.isArray(body.userRequests) || body.userRequests.length > 20 || body.userRequests.some(x => typeof x !== 'string' || x.length > 4000)) throw new Error('Invalid request summary.');
        const s: State = { schemaVersion: 2, ownerUserId: userId, runId: String(body.runId), status: 'queued', phase: 'planning', revision: 1,
          sourceReady: false, artifactVersion: 0, requiresCandidateApproval: true, documentName: body.documentName, outFileName: body.documentName.replace(/\.pdf$/i, '') + '-edited-review.pdf',
          originalPages: Number(body.totalPages), totalPages: Number(body.totalPages), operations, userRequests: body.userRequests as string[], cursor: 0, structuralDone: false,
          activePage: 1, message: 'Waiting for the approved source PDF.', errorText: '', returnUrl, createdAt: Date.now(), updatedAt: Date.now() };
        this.ctx.storage.transactionSync(() => {
          this.put(s); this.putEmail({ email, version: 1, status: email ? 'queued' : 'none', note: email ? 'Completion notification saved.' : '', attempts: 0, nextAt: 0, dispatching: false });
        });
        return response(this.status(s), 201);
      }
      const s = this.state();
      if (!s || s.deleted || s.schemaVersion !== 2 || !s.ownerUserId) return response({ error: 'Run not found or no longer available.' }, 404);
      if (s.ownerUserId !== userId) return response({ error: 'This document run belongs to another studio session.' }, 403);
      if (path === '/status' && request.method === 'GET') {
        if (!this.ticking && Date.now() >= (s.nextStepAt ?? 0) && (s.status === 'running' || (s.status === 'done' && this.email().status === 'queued'))) {
          await this.alarm();
        }
        return response(this.status(this.state() || s));
      }
      if (path === '/delete' && request.method === 'DELETE') {
        // Synchronous tombstone first: every later async completion observes it.
        const jobId = s.job?.id;
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('DELETE FROM pdf_chunks'); this.ctx.storage.sql.exec('DELETE FROM notification');
          this.put({ ...s, deleted: true, status: 'cancelled', phase: 'cancelled', revision: s.revision + 1,
            operations: [], userRequests: [], documentName: '', outFileName: '', returnUrl: '', job: undefined, errorText: '', message: '', sourceReady: false });
        });
        await this.ctx.storage.deleteAlarm();
        if (jobId) this.ctx.waitUntil(engine(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).catch(() => undefined));
        return response({ ok: true });
      }
      if (path === '/upload-source' && request.method === 'POST') {
        if (s.status !== 'queued' || s.sourceReady) return response({ error: 'The source is locked. Create a new editing round to change it.' }, 409);
        const bytes = await readLimited(request.body, MAX_PDF_BYTES); const pdf = await inspectSupportedPdf(bytes);
        this.current(s);
        if (this.state()?.sourceReady) return response({ error: 'The source was already uploaded.' }, 409);
        if (pdf.getPageCount() !== s.originalPages) throw new Error('The uploaded document differs from the approved plan.');
        s.sourceReady = true; s.artifactVersion++; s.message = 'Source saved. Ready to start.';
        this.commit(s, { source: bytes, working: bytes }); return response({ ok: true });
      }
      if (path === '/start' && request.method === 'POST') {
        if (s.status === 'queued') {
          if (!s.sourceReady) throw new Error('Upload and approve the source before starting.');
          const nextAt = Date.now() + 1000;
          // Arm before changing status: a crash cannot commit an unscheduled running job.
          await this.ctx.storage.setAlarm(nextAt); this.current(s);
          s.status = 'running'; s.phase = 'editing'; s.nextStepAt = nextAt; s.message = 'Preparing the actual PDF for your review and approval.'; s.revision++; this.put(s);
        } else if (s.status === 'running') await this.schedule(s, 1000);
        else return response({ error: 'This run is finished or stopped. Review the source and create a new run to retry.' }, 409);
        return response(this.status(s));
      }
      if (path === '/cancel' && request.method === 'POST') {
        if (s.status === 'queued' || s.status === 'running' || s.status === 'review') {
          const jobId = s.job?.id;
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec("DELETE FROM pdf_chunks WHERE slot IN ('working','candidate')");
            s.status = 'cancelled'; s.phase = 'cancelled'; s.revision++; s.candidateHash = undefined; s.job = undefined; s.nextStepAt = undefined; s.pendingSubmission = false;
            s.message = 'Cancelled. Partial output was discarded; your original source PDF is still saved.';
            this.put(s);
            const e = this.email(); e.email = ''; e.version++; e.status = 'none'; e.note = ''; this.putEmail(e);
          });
          await this.ctx.storage.deleteAlarm();
          if (jobId) this.ctx.waitUntil(engine(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).catch(() => undefined));
        }
        return response(this.status(s));
      }
      if (path === '/email' && request.method === 'POST') {
        const body = await readJson(request, 4096); this.current(s);
        const previous = this.email(); const email = validEmail(body.email);
        if (email === previous.email) return response(this.status(s));
        if (s.status === 'cancelled' || s.status === 'error') throw new Error('Notifications cannot be added to a stopped run.');
        if (previous.dispatching) return response({ error: 'A notification is already being submitted. Retry after its status updates; accepted messages cannot be recalled.' }, 409);
        this.putEmail({ email, version: previous.version + 1, status: email ? 'queued' : 'none', note: email ? 'Notification saved.' : 'Notifications removed. Previously accepted messages cannot be recalled.', attempts: 0, nextAt: 0, dispatching: false });
        if (s.status === 'done' && email) await this.schedule(s, 1000);
        return response(this.status(s));
      }
      if (path === '/approve' && request.method === 'POST') {
        const body = await readJson(request, 4096);
        const readCandidateState = () => {
          const now = this.state();
          if (!now || now.deleted || now.schemaVersion !== 2 || now.ownerUserId !== userId || now.runId !== s.runId) throw new Error('This run is no longer available.');
          assertCandidateApproval(now, body);
          return now;
        };
        let now = readCandidateState();
        if (now.status === 'done') return response(this.status(now));
        const candidate = this.bytes('candidate');
        if (!candidate) throw new Error('The saved candidate is missing. Approval was not recorded.');
        const digest = await hashPdf(candidate);
        now = readCandidateState();
        if (now.status === 'done') return response(this.status(now));
        if (digest !== now.candidateHash) throw new Error('Candidate integrity check failed. Approval was not recorded.');
        const revision = now.revision;
        const nextAt = Date.now() + 1000;
        // Schedule before committing completion; cancellation during the wait still wins.
        await this.ctx.storage.setAlarm(nextAt);
        now = readCandidateState();
        if (now.status === 'done') return response(this.status(now));
        if (now.revision !== revision) throw new Error('This run changed while approval was being saved. Reload before approving.');
        this.ctx.storage.transactionSync(() => {
          this.current(now); this.putBytes('final', candidate);
          now.status = 'done'; now.phase = 'done'; now.approvedAt = Date.now(); now.nextStepAt = nextAt; now.revision++;
          now.message = 'Your reviewed PDF is saved unchanged. Approval is your review, not independent certification of text, layout or calculations.';
          this.put(now);
        });
        return response(this.status(now));
      }
      if (request.method === 'GET' && ['/pdf', '/source', '/working', '/candidate'].includes(path)) {
        if (path === '/working' && s.status !== 'running') return response({ error: 'Partial working output is not available.' }, 409);
        if (path === '/candidate' && (!s.candidateHash || !['review', 'done'].includes(s.status))) return response({ error: 'The review candidate is not available.' }, 409);
        if (path === '/pdf' && s.status !== 'done') return response({ error: 'The finished PDF is not ready.' }, 409);
        const bytes = this.bytes(path === '/pdf' ? 'final' : path.slice(1));
        if (!bytes) return response({ error: 'No saved PDF is available yet.' }, 404);
        return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${(path === '/pdf' ? s.outFileName : 'source.pdf').replace(/[^\x20-\x7E]|["\\]/g, '_')}"` } });
      }
      return response({ error: 'Unknown action.' }, 404);
    } catch (error) { return response({ error: error instanceof Error ? error.message : 'Request could not be completed.' }, 400); }
  }
  private async schedule(s: State, delay: number) {
    this.current(s);
    const nextAt = Date.now() + delay;
    await this.ctx.storage.setAlarm(nextAt);
    // Review can become done while scheduling awaits. Never erase its newer approval alarm.
    const now = this.state();
    if (!now || now.deleted || !['running', 'review', 'done'].includes(now.status)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (now.revision === s.revision) {
      now.nextStepAt = nextAt;
      s.nextStepAt = nextAt;
      this.put(now);
    }
  }
  override async alarm(): Promise<void> {
    const s = this.state();
    if (!s || s.deleted || s.schemaVersion !== 2 || !s.ownerUserId) return;
    if (s.status !== 'running' && s.status !== 'done') return;
    if (this.ticking) { await this.schedule(s, 5000); return; }
    this.ticking = true;
    try {
      // Keep a durable watchdog armed throughout network work, including finalization/email.
      await this.schedule(s, 45_000);
      if (s.status === 'done') await this.sendEmail(s);
      else await this.step(s);
    } catch (error) {
      const now = this.state();
      if (now && !now.deleted && now.revision === s.revision && now.status === 'running') {
        now.status = 'error'; now.phase = 'error'; now.nextStepAt = undefined; now.revision++;
        now.errorText = error instanceof Error ? error.message : 'Processing interrupted.';
        now.message = now.errorText + ' Your source is retained. Review it before starting a new run.'; this.put(now);
        await this.ctx.storage.deleteAlarm();
        if (now.job?.id) this.ctx.waitUntil(engine(`/api/jobs/${encodeURIComponent(now.job.id)}/cancel`, { method: 'POST' }).catch(() => undefined));
      }
    } finally { this.ticking = false; }
  }
  private async step(s: State) {
    const edits = s.operations.filter(o => o.kind === 'text');
    const working = this.bytes('working'); if (!working) throw new Error('Working document missing.');
    if (s.cursor < edits.length) {
      const op = edits[s.cursor]; s.activePage = op.page;
      if (s.pendingSubmission && !s.job) throw new Error('The engine submission was interrupted before its receipt was saved. Automatic replay is disabled to avoid duplicate work.');
      if (!s.job) {
        const master = await PDFDocument.load(working, { updateMetadata: false }); this.current(s);
        const single = await PDFDocument.create(); const [page] = await single.copyPages(master, [op.page - 1]); single.addPage(page);
        const bytes = await single.save(); this.current(s);
        const form = new FormData(); form.append('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }), 'page.pdf');
        const upload = await engineJson<{ upload_id: string }>('/api/uploads', { method: 'POST', body: form }); this.current(s);
        if (!upload.upload_id) throw new Error('Engine did not acknowledge the upload.');
        // Persist uncertainty before issuing a non-idempotent external mutation.
        s.pendingSubmission = true; s.message = `Submitting the approved change on page ${op.page}.`; this.commit(s);
        const job = await engineJson<{ job_id: string }>('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upload_id: upload.upload_id, instruction: `change "${op.find}" to "${op.replace}"` }) });
        const now = this.state();
        if (!now || now.deleted || now.revision !== s.revision || now.status !== 'running') {
          if (job.job_id) await engine(`/api/jobs/${encodeURIComponent(job.job_id)}/cancel`, { method: 'POST' }).catch(() => undefined);
          return;
        }
        if (!job.job_id) throw new Error('Engine returned no job receipt.');
        s.job = { id: job.job_id, startedAt: Date.now(), page: op.page, cursor: s.cursor }; s.pendingSubmission = false; this.commit(s); await this.schedule(s, 1500); return;
      }
      if (Date.now() - s.job.startedAt > 10 * 60_000) throw new Error('This engine edit exceeded ten minutes.');
      const job = await engineJson<EngineJob>(`/api/jobs/${encodeURIComponent(s.job.id)}`); this.current(s);
      if (['queued', 'running'].includes(job.status)) { await this.schedule(s, 2000); return; }
      if (job.status !== 'done') throw new Error(`Engine edit did not complete (${job.status}).`);
      const results = job.edit_results;
      if (!results || results.length !== 1 || results[0].status !== 'ok' || results[0].find !== op.find || results[0].replace !== op.replace) throw new Error('The engine did not confirm the exact approved replacement. No overlay fallback was applied.');
      const edited = await engine(job.download_url || `/api/jobs/${encodeURIComponent(s.job.id)}/pdf`); this.current(s);
      const single = await inspectSupportedPdf(edited); this.current(s);
      if (single.getPageCount() !== 1) throw new Error('Engine returned an unexpected page count.');
      const master = await PDFDocument.load(working, { updateMetadata: false });
      const [page] = await master.copyPages(single, [0]);
      master.removePage(op.page - 1); master.insertPage(op.page - 1, page);
      const saved = await master.save(); this.current(s);
      s.cursor++; s.job = undefined; s.artifactVersion++; s.message = `Saved ${s.cursor} of ${edits.length} text edits. Final visual review will still be required.`;
      this.commit(s, { working: saved }); await this.schedule(s, 1000); return;
    }
    if (!s.structuralDone) {
      const master = await PDFDocument.load(working, { updateMetadata: false });
      for (const op of s.operations.filter(o => o.kind !== 'text').sort((a, b) => b.page - a.page)) {
        const index = op.page - 1;
        if (op.kind === 'delete_page') master.removePage(index);
        else if (op.kind === 'clone_page') { const [copy] = await master.copyPages(master, [index]); master.insertPage(index + 1, copy); }
        else if (op.kind === 'rotate_page') { const page = master.getPage(index); page.setRotation(degrees((page.getRotation().angle + op.rotateDegrees!) % 360)); }
      }
      const saved = await master.save(); this.current(s);
      s.totalPages = master.getPageCount(); s.structuralDone = true; s.artifactVersion++; s.phase = 'verifying'; s.message = 'Checking PDF integrity and page count. Visual and arithmetic review is still required.';
      this.commit(s, { working: saved }); await this.schedule(s, 1000); return;
    }
    const final = await inspectSupportedPdf(working); this.current(s);
    const expectedPages = s.originalPages + s.operations.filter(o => o.kind === 'clone_page').length - s.operations.filter(o => o.kind === 'delete_page').length;
    if (final.getPageCount() !== expectedPages) throw new Error('Final page count does not match the approved page actions.');
    if (s.requiresCandidateApproval) {
      const candidateHash = await hashPdf(working); this.current(s);
      this.ctx.storage.transactionSync(() => {
        this.current(s); this.putBytes('candidate', working);
        s.candidateHash = candidateHash; s.artifactVersion++; s.status = 'review'; s.phase = 'review'; s.nextStepAt = undefined; s.revision++;
        s.message = 'Actual reconstructed PDF ready. Review every page, then approve this exact file. Only integrity and page count have been checked.';
        this.put(s);
      });
      // Leave the watchdog alone. A review alarm is harmless; deleting it here
      // could erase a concurrent approval's completion-notification alarm.
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.current(s); this.putBytes('final', working);
      s.status = 'done'; s.phase = 'done'; s.message = 'PDF integrity checks passed. Review the finished text, layout and calculations before use; it is not certified.'; s.revision++; this.put(s);
    });
    await this.schedule(s, 1000);
  }
  private async sendEmail(s: State) {
    const e = this.email();
    if (!e.email || ['sent', 'none', 'failed', 'pending_provider'].includes(e.status)) { await this.ctx.storage.deleteAlarm(); return; }
    if (!this.env.RESEND_API_KEY || !this.env.RESEND_FROM_EMAIL) {
      e.status = 'pending_provider'; e.note = 'PDF ready. Notifications need a configured, verified sender.'; this.putEmail(e); await this.ctx.storage.deleteAlarm(); return;
    }
    if (e.nextAt > Date.now()) { await this.schedule(s, e.nextAt - Date.now()); return; }
    if (e.attempts >= 3) { e.status = 'failed'; e.dispatching = false; e.note = 'Delivery could not be confirmed after three attempts. Your PDF remains available here.'; this.putEmail(e); await this.ctx.storage.deleteAlarm(); return; }
    this.current(s); e.attempts++; e.dispatching = true; e.nextAt = Date.now() + 60_000; this.putEmail(e);
    const link = `${safeReturnUrl(s.returnUrl)}?run=${encodeURIComponent(s.runId)}`;
    try {
      const res = await fetch('https://api.resend.com/emails', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.env.RESEND_API_KEY}`, 'Idempotency-Key': `pdf-${s.runId}-${e.version}` },
        body: JSON.stringify({ from: this.env.RESEND_FROM_EMAIL, to: [e.email], subject: 'Your PDF is ready for review', text: `Your edited PDF is ready for review. Open it in the browser where you started this run: ${link}\nReview the result before use. This notification contains no document details.` }) });
      await res.body?.cancel(); this.current(s);
      if (this.email().version !== e.version) return;
      e.dispatching = false;
      if (res.status >= 300 && res.status < 400) { e.status = 'failed'; e.note = 'The email provider returned an unapproved redirect.'; }
      else if (res.ok) { e.status = 'sent'; e.note = 'Notification accepted by the email provider. Inbox delivery is not confirmed.'; }
      else if (res.status < 500 && res.status !== 429) { e.status = 'failed'; e.note = `The email provider refused the notification (${res.status}).`; }
      else e.note = 'The email provider is temporarily unavailable; retry scheduled.';
      this.putEmail(e);
    } catch {
      const now = this.state(); if (!now || now.deleted || now.revision !== s.revision || this.email().version !== e.version) return;
      e.dispatching = false; e.note = 'Notification acceptance is uncertain; retry uses the same delivery identifier.'; this.putEmail(e);
    }
    if (e.status === 'queued') await this.schedule(s, 60_000); else await this.ctx.storage.deleteAlarm();
  }
}

// A small, bounded owner-only index. It stores run references, never PDF bytes.
export class StudioCatalog extends DurableObject<RunnerEnv> {
  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS attempts (created INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS plans (created INTEGER NOT NULL)');
  }
  override async fetch(request: Request): Promise<Response> {
    if (!request.headers.get('X-Studio-Owner')?.trim()) return response({ error: 'Studio session required.' }, 401);
    if (request.method === 'GET') return response({ runs: this.ctx.storage.sql.exec<{ id: string; created: number }>('SELECT id,created FROM jobs ORDER BY created DESC').toArray() });
    const id = new URL(request.url).pathname.slice(1);
    if (request.method === 'DELETE') { this.ctx.storage.sql.exec('DELETE FROM jobs WHERE id=?', id); return response({ ok: true }); }
    if (id === 'ip-plan-check') {
      this.ctx.storage.sql.exec('DELETE FROM plans WHERE created<?', Date.now() - 3_600_000);
      if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM plans').toArray()[0].n >= 60) return response({ error: 'Hourly planning limit reached for this network. Please try later.' }, 429);
      this.ctx.storage.sql.exec('INSERT INTO plans VALUES(?)', Date.now()); return response({ ok: true });
    }
    if (id === 'ip-run-check') {
      const now = Date.now(); this.ctx.storage.sql.exec('DELETE FROM attempts WHERE created<?', now - 3_600_000);
      if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM attempts').toArray()[0].n >= 25) return response({ error: 'Hourly reconstruction limit reached for this network. Please try later.' }, 429);
      this.ctx.storage.sql.exec('INSERT INTO attempts VALUES(?)', now); return response({ ok: true });
    }
    if (id === 'planning-reservation') {
      this.ctx.storage.sql.exec('DELETE FROM plans WHERE created<?', Date.now() - 3_600_000);
      if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM plans').toArray()[0].n >= 30) return response({ error: 'Thirty planning requests per hour are allowed. Please try later.' }, 429);
      this.ctx.storage.sql.exec('INSERT INTO plans VALUES(?)', Date.now()); return response({ ok: true });
    }
    const now = Date.now(); this.ctx.storage.sql.exec('DELETE FROM attempts WHERE created<?', now - 3_600_000);
    const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM jobs').toArray()[0].n;
    if (count >= 20) return response({ error: 'Your studio holds 20 runs. Delete an old run before creating another.' }, 429);
    if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM attempts').toArray()[0].n >= 10) return response({ error: 'Ten runs per hour are allowed. Please try later.' }, 429);
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO jobs VALUES(?,?)', id, now); this.ctx.storage.sql.exec('INSERT INTO attempts VALUES(?)', now); return response({ ok: true });
  }
}
