import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-react';
import { page as browserPage } from 'vitest/browser';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import App from './App';
import { grantDataConsent, withdrawDataConsent } from './lib/consent';
import type { PublicRunStatus } from './lib/backend';
import type { PlanDraftResult } from './lib/ai-planner';
import { hashPdf } from '../../agentic-pdf-runner/candidate';

const mocks = vi.hoisted(() => ({ plan: vi.fn(), templates: vi.fn(), templatePdf: vi.fn(), status: vi.fn(), create: vi.fn(), upload: vi.fn(), start: vi.fn(), cancel: vi.fn(), email: vi.fn(), final: vi.fn(), source: vi.fn(), list: vi.fn(), remove: vi.fn(), approve: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), fetchHealth: async () => null, fetchTemplates: mocks.templates }));
vi.mock('./lib/ai-planner', async original => ({ ...await original<typeof import('./lib/ai-planner')>(), analyzeAndPlanEdits: mocks.plan }));
vi.mock('./lib/backend', async original => ({ ...await original<typeof import('./lib/backend')>(), getBackgroundRunStatus: mocks.status, createBackgroundRun: mocks.create, uploadRunSourcePdf: mocks.upload, startBackgroundRun: mocks.start, cancelBackgroundRun: mocks.cancel, updateRunNotificationEmail: mocks.email, fetchRunFinalPdfBytes: mocks.final, fetchRunPdf: mocks.source, listRuns: mocks.list, deleteRun: mocks.remove, approveRunCandidate: mocks.approve }));
vi.mock('./document', async original => ({ ...await original<typeof import('./document')>(), sampleEarningsPdf: async () => syntheticPdf(), fetchServerTemplatePdfBytes: mocks.templatePdf }));
async function syntheticPdf(pages = 1) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) pdf.addPage([400, 600]).drawText(`Unique label ${i + 1}`, { x: 50, y: 500, size: 14, font });
  return pdf.save();
}
const plan: PlanDraftResult = { rewrittenRequests: ['Rotate the page clockwise'], assistantSummary: 'Rotate the page clockwise.', questions: [], operations: [{ id: 'rotate', kind: 'rotate_page', page: 1, find: '', replace: '', rotateDegrees: 90, plainSummary: 'Rotate page 1' }], focalPages: [1] };
function run(overrides: Partial<PublicRunStatus> = {}): PublicRunStatus {
  return { runId: 'synthetic-known-id', status: 'running', phase: 'editing', overallPct: 15, bars: { planning: 100, editing: 0, verifying: 0 }, message: 'Processing synthetic document', documentName: 'Synthetic.pdf', outFileName: 'Synthetic-reviewed.pdf', totalPages: 1, activePage: 1, activeRegion: null, userRequests: ['Rotate page'], email: '', emailStatus: 'none', emailNote: '', emailDeliveryConfigured: false, downloadReady: false, updatedAt: 1, artifactVersion: 0, ...overrides };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const promptName = 'Describe the changes you want in plain English';
beforeEach(async () => {
  vi.resetAllMocks(); localStorage.clear(); withdrawDataConsent(); history.replaceState({}, '', location.pathname);
  mocks.templates.mockResolvedValue([]); mocks.list.mockResolvedValue({ runs: [] }); mocks.plan.mockResolvedValue(plan);
  mocks.source.mockResolvedValue({ bytes: await syntheticPdf() }); mocks.status.mockResolvedValue(run());
  mocks.create.mockResolvedValue(run({ status: 'queued', phase: 'planning' })); mocks.upload.mockResolvedValue({ ok: true }); mocks.start.mockResolvedValue(run());
  mocks.cancel.mockResolvedValue(run({ status: 'cancelled', phase: 'cancelled', message: 'Stopped safely', updatedAt: 3 }));
  mocks.email.mockResolvedValue(run({ emailNote: 'Notifications removed.', updatedAt: 4 }));
});
afterEach(async () => { await cleanup(); history.replaceState({}, '', location.pathname); withdrawDataConsent(); });
async function openSample() {
  const screen = await render(<App />);
  await screen.getByRole('button', { name: 'Sample 3-month earnings statement' }).click();
  await expect.element(screen.getByRole('textbox', { name: promptName })).toBeEnabled();
  return screen;
}
async function prepare(screen: Awaited<ReturnType<typeof render>>) {
  await screen.getByRole('textbox', { name: promptName }).fill('Rotate page 1');
  await screen.getByRole('button', { name: 'Prepare preview' }).click();
  await expect.element(screen.getByRole('button', { name: 'Prepare Actual PDF' })).toBeVisible();
}
const reviewAcknowledgement = 'I reviewed every page, including text, layout and calculations.';
async function resumeCandidate(bytes: Uint8Array, overrides: Partial<PublicRunStatus> = {}) {
  grantDataConsent();
  const candidate = run({ status: 'review', phase: 'review', artifactVersion: 3, requiresCandidateApproval: true, candidateReady: true, candidateHash: await hashPdf(bytes), overallPct: 95, ...overrides });
  mocks.status.mockResolvedValue(candidate);
  mocks.source.mockResolvedValue({ bytes });
  history.replaceState({}, '', `${location.pathname}?run=${candidate.runId}`);
  return { screen: await render(<App />), candidate };
}
describe('Private studio flow safeguards with synthetic PDFs and stubbed services', () => {
  it('preserves the typed request when consent is declined', async () => {
    const screen = await openSample(); await screen.getByRole('textbox', { name: promptName }).fill('Change the label');
    await screen.getByRole('button', { name: 'Prepare preview' }).click();
    await screen.getByRole('button', { name: 'Keep local only' }).click();
    await expect.element(screen.getByRole('textbox', { name: promptName })).toHaveValue('Change the label'); expect(mocks.plan).not.toHaveBeenCalled();
  });
  it('requires a deliberate clarification choice', async () => {
    grantDataConsent(); mocks.plan.mockResolvedValueOnce({ ...plan, operations: [], questions: [{ id: 'q', prompt: 'Which direction?', options: [{ id: 'a', label: 'Clockwise' }, { id: 'b', label: 'Counterclockwise' }] }] });
    const screen = await openSample(); await screen.getByRole('textbox', { name: promptName }).fill('Rotate'); await screen.getByRole('button', { name: 'Prepare preview' }).click();
    await expect.element(screen.getByRole('button', { name: 'Confirm & Preview in Flipbook' })).toBeDisabled();
    await screen.getByRole('button', { name: 'Clockwise', exact: true }).click();
    await expect.element(screen.getByRole('button', { name: 'Confirm & Preview in Flipbook' })).toBeEnabled();
  });
  it('removes stale approval when refinement fails', async () => {
    grantDataConsent(); const screen = await openSample(); await prepare(screen);
    mocks.plan.mockRejectedValueOnce(new Error('Synthetic planner unavailable'));
    await screen.getByRole('textbox', { name: promptName }).fill('Make a different change'); await screen.getByRole('button', { name: 'Prepare preview' }).click();
    await expect.element(screen.getByText('Synthetic planner unavailable')).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Prepare Actual PDF' })).not.toBeInTheDocument(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('does not reuse a previous PDF after a template fails', async () => {
    mocks.templates.mockResolvedValue([{ key: 'synthetic-template', name: 'Synthetic template', ok: true, pages: 1, targets: [] }]);
    mocks.templatePdf.mockRejectedValue(new Error('Synthetic template unavailable'));
    const screen = await openSample(); await screen.getByRole('button', { name: 'Browse point-of-truth templates' }).click();
    await screen.getByRole('button', { name: /Synthetic template/ }).click();
    await expect.element(screen.getByText('Synthetic template unavailable')).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: promptName })).not.toBeInTheDocument();
  });
  it('cancels a start receipt that arrives after permission withdrawal', async () => {
    grantDataConsent(); const pendingStart = deferred<PublicRunStatus>(); mocks.start.mockReturnValue(pendingStart.promise);
    const screen = await openSample(); await prepare(screen); await screen.getByRole('button', { name: 'Prepare Actual PDF' }).click();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    await screen.getByRole('button', { name: 'Privacy and studio settings' }).click(); await screen.getByRole('button', { name: 'Withdraw AI & Cloud Data Permission' }).click();
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce()); pendingStart.resolve(run());
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(2));
    await expect.element(screen.getByRole('button', { name: 'Reopen Saved Source' })).toBeVisible();
  });
  it('asks for confirmation before cancelling an in-progress run, keeps running when dismissed, and discards partial output when confirmed', async () => {
    grantDataConsent();
    const partialBytes = await syntheticPdf();
    mocks.status.mockResolvedValue(run({ status: 'running', phase: 'editing', artifactVersion: 1, overallPct: 48 }));
    mocks.source.mockResolvedValue({ bytes: partialBytes });
    history.replaceState({}, '', `${location.pathname}?run=synthetic-known-id`);
    const screen = await render(<App />);
    await expect.element(screen.getByText('Showing the latest saved working PDF — not a simulated edit animation.')).toBeVisible();
    await screen.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.element(screen.getByRole('heading', { name: 'Cancel this PDF run?' })).toBeVisible();
    await expect.element(screen.getByText(/permanently discards any partial or unapproved PDF output/)).toBeVisible();
    expect(mocks.cancel).not.toHaveBeenCalled();
    await screen.getByRole('button', { name: 'Keep Running' }).click();
    await expect.element(screen.getByText('Cancel this PDF run?')).not.toBeVisible();
    expect(mocks.cancel).not.toHaveBeenCalled();
    await expect.element(screen.getByText('Showing the latest saved working PDF — not a simulated edit animation.')).toBeVisible();
    mocks.cancel.mockImplementation(async () => {
      const stopped = run({ status: 'cancelled', phase: 'cancelled', message: 'Cancelled by user. Partial output was discarded; your original PDF remains intact.', artifactVersion: 2, updatedAt: 5 });
      mocks.status.mockResolvedValue(stopped);
      return stopped;
    });
    await screen.getByRole('button', { name: 'Stop', exact: true }).click();
    await screen.getByRole('button', { name: 'Cancel Run & Discard Output' }).click();
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('synthetic-known-id'));
    await expect.element(screen.getByRole('button', { name: 'Reopen Saved Source' })).toBeVisible();
    await expect.element(screen.getByText(/Run cancelled and partial PDF output discarded/)).toBeVisible();
    await expect.element(screen.getByText('Showing the latest saved working PDF — not a simulated edit animation.')).not.toBeInTheDocument();
  });
  it('allows email removal without asking for processing permission', async () => {
    history.replaceState({}, '', `${location.pathname}?run=synthetic-known-id`); const screen = await render(<App />);
    await screen.getByRole('button', { name: 'Remove Email' }).click();
    await vi.waitFor(() => expect(mocks.email).toHaveBeenCalledWith('synthetic-known-id', '', expect.any(String)));
    await expect.element(screen.getByText('Before we analyze or reconstruct your PDF')).not.toBeVisible();
  });
  it('blocks a second round and download after the final PDF fails to load', async () => {
    mocks.status.mockResolvedValue(run({ status: 'done', phase: 'done', artifactVersion: 2, downloadReady: true })); mocks.final.mockRejectedValue(new Error('Synthetic final download unavailable'));
    history.replaceState({}, '', `${location.pathname}?run=synthetic-known-id`); const screen = await render(<App />);
    await expect.element(screen.getByRole('button', { name: 'Retry PDF load' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Make Another Edit' })).toBeDisabled();
    await expect.element(screen.getByRole('link', { name: 'Download Finished PDF' })).not.toBeInTheDocument();
  });
  it('retries final loading and clears the old run before a second round', async () => {
    mocks.status.mockResolvedValue(run({ status: 'done', phase: 'done', artifactVersion: 2, downloadReady: true }));
    mocks.final.mockRejectedValueOnce(new Error('Synthetic download interrupted')).mockResolvedValue({ bytes: await syntheticPdf(), filename: 'Synthetic-reviewed.pdf' });
    history.replaceState({}, '', `${location.pathname}?run=synthetic-known-id`); const screen = await render(<App />);
    await screen.getByRole('button', { name: 'Retry PDF load' }).click();
    await expect.element(screen.getByRole('link', { name: 'Download Finished PDF' })).toBeVisible();
    await screen.getByRole('button', { name: 'Make Another Edit' }).click();
    await expect.element(screen.getByRole('textbox', { name: promptName })).toBeEnabled();
    await expect.element(screen.getByRole('link', { name: 'Download Finished PDF' })).not.toBeInTheDocument();
    await expect.element(screen.getByText('Rotate page', { exact: true })).not.toBeInTheDocument(); expect(location.search).toBe('');
  });
  it('requires actual PDF rendering and acknowledgement before exact-byte approval', async () => {
    const bytes = await syntheticPdf(); const { screen, candidate } = await resumeCandidate(bytes);
    await expect.element(screen.getByRole('checkbox', { name: reviewAcknowledgement })).toBeEnabled();
    await expect.element(screen.getByRole('button', { name: 'Approve This PDF', exact: true })).toBeDisabled();
    await expect.element(screen.getByRole('link', { name: 'Download Finished PDF' })).not.toBeInTheDocument();
    expect(mocks.final).not.toHaveBeenCalled();
    await screen.getByRole('checkbox', { name: reviewAcknowledgement }).click();
    const done = { ...candidate, status: 'done' as const, phase: 'done' as const, approvedAt: 100, updatedAt: 10, downloadReady: true };
    mocks.approve.mockImplementation(async () => { mocks.status.mockResolvedValue(done); return done; });
    mocks.final.mockResolvedValue({ bytes, filename: 'approved.pdf' });
    await screen.getByRole('button', { name: 'Approve This PDF', exact: true }).click();
    await vi.waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(candidate.runId, candidate.candidateHash, 3));
    const link = screen.getByRole('link', { name: 'Download Finished PDF' }); await expect.element(link).toBeVisible();
    const href = (link.element() as HTMLAnchorElement).href;
    expect(new Uint8Array(await (await fetch(href)).arrayBuffer())).toEqual(bytes);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('blocks approval when the candidate download does not match its saved fingerprint', async () => {
    const { screen } = await resumeCandidate(await syntheticPdf(), { candidateHash: 'f'.repeat(64) });
    await expect.element(screen.getByRole('button', { name: 'Retry PDF load' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Approve This PDF', exact: true })).toBeDisabled();
    await expect.element(screen.getByRole('checkbox', { name: reviewAcknowledgement })).toBeDisabled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('requires all candidate pages to render and clears acknowledgement when viewing the original', async () => {
    await browserPage.viewport(1200, 900);
    const { screen } = await resumeCandidate(await syntheticPdf(6), { totalPages: 6 });
    await expect.element(screen.getByRole('button', { name: 'Actual PDF', exact: true })).toBeVisible();
    await expect.element(screen.getByRole('checkbox', { name: reviewAcknowledgement })).toBeDisabled();
    await screen.getByRole('button', { name: 'Single', exact: true }).click();
    for (let page = 1; page < 6; page++) {
      await screen.getByRole('button', { name: 'Next page' }).click();
      await expect.element(screen.getByLabelText(`Document page ${page + 1}`)).toBeInTheDocument();
    }
    await expect.element(screen.getByRole('checkbox', { name: reviewAcknowledgement })).toBeEnabled();
    await screen.getByRole('checkbox', { name: reviewAcknowledgement }).click();
    await screen.getByRole('button', { name: 'Original', exact: true }).click();
    await expect.element(screen.getByRole('checkbox', { name: reviewAcknowledgement })).not.toBeChecked();
    await expect.element(screen.getByRole('button', { name: 'Approve This PDF', exact: true })).toBeDisabled();
  });
  it('keeps approval retryable after a failed receipt without reconstructing again', async () => {
    const { screen } = await resumeCandidate(await syntheticPdf()); mocks.approve.mockRejectedValue(new Error('Synthetic approval unavailable'));
    await expect.element(screen.getByRole('checkbox', { name: reviewAcknowledgement })).toBeEnabled();
    await screen.getByRole('checkbox', { name: reviewAcknowledgement }).click(); await screen.getByRole('button', { name: 'Approve This PDF', exact: true }).click();
    await expect.element(screen.getByText(/Synthetic approval unavailable/)).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Approve This PDF', exact: true })).toBeEnabled();
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.final).not.toHaveBeenCalled();
  });
  it('cancels a candidate before reopening the original for renewed approval', async () => {
    const { screen, candidate } = await resumeCandidate(await syntheticPdf());
    await screen.getByRole('button', { name: 'Revise From Original' }).click();
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(candidate.runId));
    await expect.element(screen.getByRole('textbox', { name: promptName })).toBeEnabled();
    await expect.element(screen.getByRole('button', { name: 'Approve This PDF', exact: true })).not.toBeInTheDocument();
    expect(mocks.approve).not.toHaveBeenCalled(); expect(location.search).toBe('');
  });
  it('refuses a final download that differs from the approved candidate', async () => {
    mocks.status.mockResolvedValue(run({ status: 'done', phase: 'done', artifactVersion: 3, requiresCandidateApproval: true, candidateHash: 'a'.repeat(64), downloadReady: true, approvedAt: 100 }));
    mocks.final.mockResolvedValue({ bytes: await syntheticPdf() }); history.replaceState({}, '', `${location.pathname}?run=synthetic-known-id`);
    const screen = await render(<App />);
    await expect.element(screen.getByRole('button', { name: 'Retry PDF load' })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Download Finished PDF' })).not.toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: 'Make Another Edit' })).toBeDisabled();
  });
  it('keeps a retained document visible when deletion fails', async () => {
    mocks.list.mockResolvedValue({ runs: [run()] }); mocks.remove.mockRejectedValue(new Error('Synthetic deletion failed'));
    const screen = await render(<App />); await screen.getByRole('button', { name: 'Privacy & retained documents' }).click();
    await screen.getByRole('button', { name: 'Delete Now', exact: true }).click(); await screen.getByRole('button', { name: 'Confirm Delete Now' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Synthetic deletion failed');
    await expect.element(screen.getByText('Synthetic.pdf', { exact: true })).toBeVisible();
  });
});
