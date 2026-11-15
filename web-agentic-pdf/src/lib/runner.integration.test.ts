import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { hashPdf } from '../../../agentic-pdf-runner/candidate';
import type { PublicRunStatus } from './backend';

// Real local workerd + SQLite, controlled alarm ticks, no external services or credentials.
let script: string;
let mf: Miniflare;
let source: Uint8Array;
let outbound: string[];
beforeAll(async () => {
  const bundled = await build({ entryPoints: [new URL('../../../agentic-pdf-runner/test/worker-harness.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  script = bundled.outputFiles[0].text;
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const label of ['First synthetic page', 'Second synthetic page']) pdf.addPage([400, 600]).drawText(label, { x: 40, y: 520, size: 14, font });
  source = await pdf.save();
});
beforeEach(() => {
  outbound = [];
  mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-05-01',
    bindings: { STUDIO_OWNER_USER_ID: 'synthetic-owner' },
    durableObjects: { RUN_COORDINATOR: { className: 'RunCoordinator', useSQLite: true }, STUDIO_CATALOG: { className: 'StudioCatalog', useSQLite: true } },
    outboundService: request => { outbound.push(request.url); return new Response('All external requests blocked by synthetic test', { status: 503 }); },
  });
});
afterEach(async () => { await mf?.dispose(); expect(outbound).toEqual([]); });
function request(path: string, method = 'GET', body?: unknown, owner = 'synthetic-owner') {
  return mf.dispatchFetch(`https://synthetic.test${path}`, { method, headers: { 'X-Rork-User-Id': owner, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function status(id: string) { const response = await request(`/runs/${id}`); expect(response.status).toBe(200); return response.json() as Promise<PublicRunStatus>; }
async function prepare(legacy = false, email = '') {
  const created = await request('/runs', 'POST', { documentName: 'Synthetic.pdf', totalPages: 2, userRequests: ['Rotate first page and copy second'], returnUrl: 'https://agentic-pdf-edit.rork.app/', email, requiresCandidateApproval: false,
    operations: [{ id: 'rotate', kind: 'rotate_page', page: 1, find: '', replace: '', rotateDegrees: 90, plainSummary: 'Rotate first page' }, { id: 'clone', kind: 'clone_page', page: 2, find: '', replace: '', plainSummary: 'Copy second page' }] });
  expect(created.status).toBe(201); const initial = await created.json() as PublicRunStatus;
  expect(initial.requiresCandidateApproval).toBe(true); const id = initial.runId;
  if (legacy) expect((await request(`/__test/legacy/${id}`, 'POST')).ok).toBe(true);
  const upload = await mf.dispatchFetch(`https://synthetic.test/runs/${id}/source`, { method: 'POST', headers: { 'X-Rork-User-Id': 'synthetic-owner', 'Content-Type': 'application/pdf' }, body: source });
  expect(upload.status).toBe(200); expect((await request(`/runs/${id}/start`, 'POST')).ok).toBe(true);
  expect((await request(`/__test/tick/${id}`, 'POST')).ok).toBe(true); // structural checkpoint
  expect((await request(`/__test/tick/${id}`, 'POST')).ok).toBe(true); // integrity check / freeze
  return status(id);
}
function approveBody(run: PublicRunStatus) { return { candidateHash: run.candidateHash, artifactVersion: run.artifactVersion }; }
async function pdf(path: string) { const response = await request(path); expect(response.status).toBe(200); return new Uint8Array(await response.arrayBuffer()); }

describe('Isolated durable runner candidate lifecycle', () => {
  it('freezes the reconstructed candidate and promotes identical bytes only after exact approval', async () => {
    const review = await prepare(); expect(review.status).toBe('review'); expect(review.downloadReady).toBe(false); expect(review.bars.verifying).toBe(100);
    const id = review.runId; expect((await request(`/runs/${id}/pdf`)).status).toBe(409);
    const candidate = await pdf(`/runs/${id}/candidate`); expect(await hashPdf(candidate)).toBe(review.candidateHash);
    const reconstructed = await PDFDocument.load(candidate); expect(reconstructed.getPageCount()).toBe(3); expect(reconstructed.getPage(0).getRotation().angle).toBe(90);
    expect(await pdf(`/runs/${id}/source`)).toEqual(source);
    expect((await request(`/runs/${id}/approve`, 'POST', { ...approveBody(review), candidateHash: 'f'.repeat(64) })).status).toBe(400);
    expect((await request(`/runs/${id}/approve`, 'POST', { ...approveBody(review), artifactVersion: review.artifactVersion! - 1 })).status).toBe(400);
    const responses = await Promise.all([request(`/runs/${id}/approve`, 'POST', approveBody(review)), request(`/runs/${id}/approve`, 'POST', approveBody(review))]);
    for (const response of responses) expect(response.status).toBe(200);
    const done = await status(id); expect(done.status).toBe('done'); expect(done.approvedAt).toBeGreaterThan(0);
    const approvedAt = done.approvedAt; expect(await pdf(`/runs/${id}/pdf`)).toEqual(candidate);
    await request(`/runs/${id}/approve`, 'POST', approveBody(review)); expect((await status(id)).approvedAt).toBe(approvedAt);
    expect((await request(`/runs/${id}/start`, 'POST')).status).toBe(409);
  });
  it('retains candidate review without sending email and preserves recipient removal during approval', async () => {
    const review = await prepare(false, 'synthetic@example.test'); const id = review.runId;
    expect(review.emailStatus).toBe('queued'); await request(`/__test/tick/${id}`, 'POST'); expect((await status(id)).status).toBe('review');
    expect((await request(`/runs/${id}/email`, 'POST', { email: '' })).ok).toBe(true);
    const before = await (await request(`/__test/storage/${id}`)).json() as { notifications: { value: string }[] };
    expect((await request(`/runs/${id}/approve`, 'POST', approveBody(review))).ok).toBe(true);
    const after = await (await request(`/__test/storage/${id}`)).json() as { notifications: { value: string }[] };
    expect(after.notifications).toEqual(before.notifications);
    await request(`/__test/tick/${id}`, 'POST'); const done = await status(id); expect(done.emailStatus).toBe('none'); expect(done.email).toBe('');
  });
  it('makes cancellation final and deletion inaccessible without erasing unrelated runs', async () => {
    const review = await prepare(); const unrelated = await prepare(); const id = review.runId;
    expect((await request(`/runs/${id}/cancel`, 'POST')).ok).toBe(true);
    expect((await request(`/runs/${id}/approve`, 'POST', approveBody(review))).status).toBe(400);
    expect((await request(`/runs/${id}/candidate`)).status).toBe(409); expect((await request(`/runs/${id}/pdf`)).status).toBe(409);
    await request(`/__test/tick/${id}`, 'POST'); expect((await status(id)).status).toBe('cancelled');
    expect((await request(`/runs/${id}`, 'DELETE')).ok).toBe(true);
    for (const path of ['', '/candidate', '/source', '/working', '/pdf']) expect((await request(`/runs/${id}${path}`)).status).toBe(404);
    expect((await request(`/runs/${id}/approve`, 'POST', approveBody(review))).status).toBe(404);
    const stored = await (await request(`/__test/storage/${id}`)).json() as { state: { deleted: boolean; operations: unknown[] }; chunks: unknown[]; notifications: unknown[] };
    expect(stored.state.deleted).toBe(true); expect(stored.state.operations).toEqual([]); expect(stored.chunks).toEqual([]); expect(stored.notifications).toEqual([]);
    expect((await status(unrelated.runId)).status).toBe('review');
  });
  it('discards an in-flight approval after cancellation or deletion while reading its body', async () => {
    for (const action of ['cancel', 'delete']) {
      const review = await prepare(); const id = review.runId;
      await request(`/__test/hold/${id}`, 'POST');
      const pendingApproval = request(`/runs/${id}/approve`, 'POST', approveBody(review));
      await vi.waitFor(async () => { const gate = await (await request(`/__test/paused/${id}`)).json() as { paused: boolean }; expect(gate.paused).toBe(true); });
      const stopped = action === 'delete' ? await request(`/runs/${id}`, 'DELETE') : await request(`/runs/${id}/cancel`, 'POST');
      expect(stopped.ok).toBe(true); await request(`/__test/release/${id}`, 'POST');
      expect((await pendingApproval).status).toBe(400);
      await request(`/__test/tick/${id}`, 'POST');
      expect((await request(`/runs/${id}/pdf`)).status).toBe(action === 'delete' ? 404 : 409);
      if (action === 'cancel') expect((await status(id)).status).toBe('cancelled');
      else expect((await request(`/runs/${id}`)).status).toBe(404);
    }
  });
  it('rejects another owner and refuses corrupted candidate bytes', async () => {
    const review = await prepare(); const id = review.runId;
    expect((await request(`/runs/${id}/candidate`, 'GET', undefined, 'synthetic-other')).status).toBe(403);
    expect((await request(`/runs/${id}/approve`, 'POST', approveBody(review), 'synthetic-other')).status).toBe(403);
    await request(`/__test/tamper/${id}`, 'POST');
    const approval = await request(`/runs/${id}/approve`, 'POST', approveBody(review)); expect(approval.status).toBe(400); expect(await approval.text()).toContain('integrity');
    expect((await status(id)).status).toBe('review'); expect((await request(`/runs/${id}/pdf`)).status).toBe(409);
  });
  it('preserves the old completion path for an already-persisted pre-approval run', async () => {
    const done = await prepare(true); expect(done.status).toBe('done'); expect(done.requiresCandidateApproval).toBe(false); expect(done.candidateReady).toBe(false);
    expect((await request(`/runs/${done.runId}/pdf`)).status).toBe(200);
    expect((await request(`/runs/${done.runId}/approve`, 'POST', { candidateHash: 'a'.repeat(64), artifactVersion: done.artifactVersion })).status).toBe(400);
  });
  it('discards partial working PDF chunks on cancel while retaining immutable source', async () => {
    const created = await request('/runs', 'POST', { documentName: 'Partial.pdf', totalPages: 2, userRequests: ['Rotate first page'], returnUrl: 'https://agentic-pdf-edit.rork.app/',
      operations: [{ id: 'rotate', kind: 'rotate_page', page: 1, find: '', replace: '', rotateDegrees: 90, plainSummary: 'Rotate first page' }] });
    expect(created.status).toBe(201);
    const { runId: id } = await created.json() as PublicRunStatus;
    expect((await mf.dispatchFetch(`https://synthetic.test/runs/${id}/source`, { method: 'POST', headers: { 'X-Rork-User-Id': 'synthetic-owner', 'Content-Type': 'application/pdf' }, body: source })).status).toBe(200);
    expect((await request(`/runs/${id}/start`, 'POST')).ok).toBe(true);
    expect((await request(`/__test/tick/${id}`, 'POST')).ok).toBe(true);
    const inProgress = await status(id);
    expect(inProgress.status).toBe('running');
    expect((await request(`/runs/${id}/working`)).status).toBe(200);
    const beforeCancel = await (await request(`/__test/storage/${id}`)).json() as { chunks: { slot: string; n: number }[] };
    expect(beforeCancel.chunks.map(c => c.slot).sort()).toEqual(['source', 'working']);
    const cancelledRes = await request(`/runs/${id}/cancel`, 'POST');
    expect(cancelledRes.status).toBe(200);
    const cancelled = await cancelledRes.json() as PublicRunStatus;
    expect(cancelled.status).toBe('cancelled');
    expect((await request(`/runs/${id}/working`)).status).toBe(409);
    expect((await request(`/runs/${id}/candidate`)).status).toBe(409);
    const afterCancel = await (await request(`/__test/storage/${id}`)).json() as { chunks: { slot: string; n: number }[] };
    expect(afterCancel.chunks.map(c => c.slot)).toEqual(['source']);
    expect(await pdf(`/runs/${id}/source`)).toEqual(source);
  });
  it('allows open studio client sessions without sign-in while isolating visitors from one another', async () => {
    expect((await mf.dispatchFetch('https://synthetic.test/runs')).status).toBe(401);
    expect((await mf.dispatchFetch('https://synthetic.test/runs', { headers: { 'X-Studio-Client-Key': 'too-short' } })).status).toBe(401);
    const clientReq = (clientKey: string, path: string, method = 'GET', body?: unknown) =>
      mf.dispatchFetch(`https://synthetic.test${path}`, { method, headers: { 'X-Studio-Client-Key': clientKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const visitorA = 'visitor-alpha-session-key-00000001';
    const visitorB = 'visitor-bravo-session-key-00000002';
    const accessA = await (await clientReq(visitorA, '/access')).json() as { allowed: boolean; publicAccess: boolean; userId: string | null };
    expect(accessA.allowed).toBe(true); expect(accessA.publicAccess).toBe(true); expect(accessA.userId).toBeNull();
    const createdA = await clientReq(visitorA, '/runs', 'POST', { documentName: 'VisitorA.pdf', totalPages: 2, userRequests: ['Rotate page 1'], returnUrl: 'https://agentic-pdf-edit.rork.app/',
      operations: [{ id: 'rotate', kind: 'rotate_page', page: 1, find: '', replace: '', rotateDegrees: 90, plainSummary: 'Rotate page 1' }] });
    expect(createdA.status).toBe(201);
    const runA = await createdA.json() as PublicRunStatus;
    expect((await (await clientReq(visitorA, '/runs')).json() as { runs: PublicRunStatus[] }).runs.map(r => r.runId)).toEqual([runA.runId]);
    expect((await (await clientReq(visitorB, '/runs')).json() as { runs: PublicRunStatus[] }).runs).toEqual([]);
    expect((await clientReq(visitorB, `/runs/${runA.runId}`)).status).toBe(403);
    expect((await clientReq(visitorB, `/runs/${runA.runId}/cancel`, 'POST')).status).toBe(403);
    expect((await clientReq(visitorB, `/runs/${runA.runId}`, 'DELETE')).status).toBe(403);
  });
  it('uses workerd-compatible manual redirect mode on outbound AI and engine calls and rejects 3xx redirects', async () => {
    await mf.dispose();
    const seenUrls: string[] = [];
    let shouldRedirect = false;
    mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-05-01',
      bindings: { STUDIO_OWNER_USER_ID: 'synthetic-owner', EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: 'synthetic-test-key' },
      durableObjects: { RUN_COORDINATOR: { className: 'RunCoordinator', useSQLite: true }, STUDIO_CATALOG: { className: 'StudioCatalog', useSQLite: true } },
      outboundService: req => {
        seenUrls.push(req.url);
        if (shouldRedirect) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/steal' } });
        if (req.url === 'https://toolkit.rork.com/v2/vercel/v1/chat/completions') {
          return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
        }
        if (req.url === 'https://api-production-f0b01d62.up.railway.app/api/uploads') {
          return Response.json({ upload_id: 'in/synthetic.pdf' });
        }
        if (req.url === 'https://api-production-f0b01d62.up.railway.app/api/jobs') {
          return Response.json({ job_id: 'job_synth_1' });
        }
        return new Response('Unexpected URL', { status: 500 });
      },
    });
    const planOk = await mf.dispatchFetch('https://synthetic.test/plan', {
      method: 'POST',
      headers: { 'X-Studio-Client-Key': 'visitor-edge-plan-session-key-0001', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }] }),
    });
    expect(planOk.status).toBe(200);
    expect(await planOk.json()).toEqual({ choices: [{ message: { content: '{"ok":true}' } }] });

    shouldRedirect = true;
    const planRedirect = await mf.dispatchFetch('https://synthetic.test/plan', {
      method: 'POST',
      headers: { 'X-Studio-Client-Key': 'visitor-edge-plan-session-key-0001', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }] }),
    });
    expect(planRedirect.status).toBe(502);
    expect(await planRedirect.text()).toContain('redirect rejected');
    expect(seenUrls.some(u => u.includes('untrusted.example'))).toBe(false);

    const created = await request('/runs', 'POST', { documentName: 'TextRedirect.pdf', totalPages: 2, userRequests: ['Change page 1 text'], returnUrl: 'https://agentic-pdf-edit.rork.app/',
      operations: [{ id: 'txt-1', kind: 'text', page: 1, find: 'First synthetic page', replace: 'Updated synthetic page', plainSummary: 'Update page 1' }] });
    const { runId } = await created.json() as PublicRunStatus;
    expect((await mf.dispatchFetch(`https://synthetic.test/runs/${runId}/source`, { method: 'POST', headers: { 'X-Rork-User-Id': 'synthetic-owner', 'Content-Type': 'application/pdf' }, body: source })).status).toBe(200);
    expect((await request(`/runs/${runId}/start`, 'POST')).ok).toBe(true);
    await request(`/__test/tick/${runId}`, 'POST');
    const errored = await status(runId);
    expect(errored.status).toBe('error');
    expect(errored.errorText).toContain('unapproved redirect');
    expect(seenUrls.some(u => u.includes('untrusted.example'))).toBe(false);
  });

  it('drives due Durable Object steps on status polls even when native DO alarms never fire', async () => {
    const created = await request('/runs', 'POST', { documentName: 'PollDriven.pdf', totalPages: 2, userRequests: ['Rotate page 1'], returnUrl: 'https://agentic-pdf-edit.rork.app/',
      operations: [{ id: 'rot-1', kind: 'rotate_page', page: 1, find: '', replace: '', rotateDegrees: 90, plainSummary: 'Rotate page 1' }] });
    const { runId } = await created.json() as PublicRunStatus;
    expect((await mf.dispatchFetch(`https://synthetic.test/runs/${runId}/source`, { method: 'POST', headers: { 'X-Rork-User-Id': 'synthetic-owner', 'Content-Type': 'application/pdf' }, body: source })).status).toBe(200);
    expect((await request(`/runs/${runId}/start`, 'POST')).ok).toBe(true);
    expect((await request(`/__test/drop-alarm/${runId}`, 'POST')).ok).toBe(true);

    let current = await status(runId);
    for (let i = 0; i < 6 && current.status !== 'review'; i++) {
      await new Promise(resolve => setTimeout(resolve, 1100));
      current = await status(runId);
      expect((await request(`/__test/drop-alarm/${runId}`, 'POST')).ok).toBe(true);
    }
    expect(current.status).toBe('review');
    expect(current.candidateReady).toBe(true);
  }, 15_000);
});
