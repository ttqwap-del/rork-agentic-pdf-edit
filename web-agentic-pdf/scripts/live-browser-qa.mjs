import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from '/usr/local/lib/node_modules/playwright/index.mjs';
import * as pdfjs from '/home/user/rork-app/web-agentic-pdf/node_modules/pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire('/home/user/rork-app/web-agentic-pdf/package.json');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const STUDIO_URL = 'https://fp0et9oqqbr0kamofkwoe-web-agentic-pdf.rork.live';
const RUNNER_URL = 'https://fp0et9oqqbr0kamofkwoe-agentic-pdf-runner.rork.live';
const OUT_DIR = '/home/user/rork-app/.rork/web-verification';
fs.mkdirSync(OUT_DIR, { recursive: true });

const baseTmp = process.env.TMPDIR || '/var/tmp';
const scratchDir = fs.mkdtempSync(path.join(baseTmp, 'agentic-pdf-qa-'));

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function buildSyntheticRetainerPdf(outPath) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const dark = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.32, 0.36, 0.42);

  // Page 1 — Two-column institutional retainer statement
  const p1 = doc.addPage([612, 792]);
  p1.drawText('NORTHSTAR ADVISORY PARTNERS', { x: 56, y: 716, size: 18, font: bold, color: dark });
  p1.drawText('Q1 2026 Retainer Statement', { x: 56, y: 676, size: 14, font: bold, color: dark });
  p1.drawText('Engagement Reference', { x: 56, y: 630, size: 11, font, color: muted });
  p1.drawText('NV-2026-Q1', { x: 320, y: 630, size: 11, font: bold, color: dark });
  p1.drawText('Statement Date', { x: 56, y: 602, size: 11, font, color: muted });
  p1.drawText('January 15, 2026', { x: 320, y: 602, size: 11, font, color: dark });
  p1.drawText('Billing Period', { x: 56, y: 574, size: 11, font, color: muted });
  p1.drawText('Jan - Mar 2026', { x: 320, y: 574, size: 11, font, color: dark });
  p1.drawText('Client Entity', { x: 56, y: 546, size: 11, font, color: muted });
  p1.drawText('Meridian Harbor Holdings LLC', { x: 320, y: 546, size: 11, font, color: dark });
  p1.drawText('Payment Terms', { x: 56, y: 518, size: 11, font, color: muted });
  p1.drawText('Net 30 Days', { x: 320, y: 518, size: 11, font, color: dark });
  p1.drawText('Page 1 of 2', { x: 56, y: 64, size: 10, font, color: muted });

  // Page 2 — Two-column fee schedule
  const p2 = doc.addPage([612, 792]);
  p2.drawText('QUARTERLY FEE SCHEDULE', { x: 56, y: 716, size: 16, font: bold, color: dark });
  p2.drawText('Core Strategic Retainer Fee', { x: 56, y: 660, size: 11, font, color: dark });
  p2.drawText('$12,000.00', { x: 420, y: 660, size: 11, font, color: dark });
  p2.drawText('Quantitative Risk Add-On', { x: 56, y: 632, size: 11, font, color: dark });
  p2.drawText('$3,500.00', { x: 420, y: 632, size: 11, font, color: dark });
  p2.drawText('Quarterly Subtotal', { x: 56, y: 594, size: 11.5, font: bold, color: dark });
  p2.drawText('$15,500.00', { x: 420, y: 594, size: 11.5, font: bold, color: dark });
  p2.drawText('Advisory Tax (8%)', { x: 56, y: 566, size: 11, font, color: dark });
  p2.drawText('$1,240.00', { x: 420, y: 566, size: 11, font, color: dark });
  p2.drawText('Total Amount Due', { x: 56, y: 532, size: 13, font: bold, color: dark });
  p2.drawText('$16,740.00', { x: 420, y: 532, size: 13, font: bold, color: dark });
  p2.drawText('Remittance Due Date', { x: 56, y: 492, size: 11, font, color: muted });
  p2.drawText('February 14, 2026', { x: 420, y: 492, size: 11, font, color: dark });
  p2.drawText('Page 2 of 2', { x: 56, y: 64, size: 10, font, color: muted });

  const bytes = await doc.save();
  fs.writeFileSync(outPath, bytes);
  return bytes;
}

async function extractPdfPageTexts(pdfBuffer) {
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), disableWorker: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => ('str' in it ? it.str : '')).filter(Boolean);
    pages.push(strings.join(' '));
  }
  return pages;
}

async function renderDownloadedPdfSpread(browser, pdfBytes, outScreenshotPath) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const pdfJsCode = fs.readFileSync('/home/user/rork-app/web-agentic-pdf/node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'utf8');
  const pdfWorkerCode = fs.readFileSync('/home/user/rork-app/web-agentic-pdf/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'utf8');
  const b64 = Buffer.from(pdfBytes).toString('base64');

  await p.setContent(`<!doctype html>
  <html>
    <head>
      <style>
        body { margin: 0; background: #090B0E; color: #F5F3ED; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 14px; }
        h1 { font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: #C6CDD4; margin: 0; }
        .spread { display: flex; gap: 20px; align-items: center; justify-content: center; }
        canvas { background: #F5F3ED; border-radius: 6px; box-shadow: 0 18px 48px rgba(0,0,0,0.65); max-height: 710px; width: auto; }
      </style>
    </head>
    <body>
      <h1>Downloaded Approved Final PDF — Actual Reconstructed Page 1 & Page 2</h1>
      <div class="spread">
        <canvas id="c1"></canvas>
        <canvas id="c2"></canvas>
      </div>
    </body>
  </html>`);

  await p.evaluate(async ({ pdfJsSrc, workerSrc, base64Pdf }) => {
    const workerBlob = new Blob([workerSrc], { type: 'text/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);
    const modBlob = new Blob([pdfJsSrc], { type: 'text/javascript' });
    const modUrl = URL.createObjectURL(modBlob);
    const pdfjsLib = await import(modUrl);
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

    const raw = Uint8Array.from(atob(base64Pdf), (c) => c.charCodeAt(0));
    const doc = await pdfjsLib.getDocument({ data: raw }).promise;
    for (let i = 1; i <= Math.min(2, doc.numPages); i++) {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1.35 });
      const canvas = document.getElementById(`c${i}`);
      canvas.width = vp.width;
      canvas.height = vp.height;
      await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }
  }, { pdfJsSrc: pdfJsCode, workerSrc: pdfWorkerCode, base64Pdf: b64 });

  await p.screenshot({ path: outScreenshotPath });
  await ctx.close();
}

const report = {
  viewport: '1280x800',
  studioUrl: STUDIO_URL,
  runnerUrl: RUNNER_URL,
  steps: {},
  pageErrors: [],
  consoleErrors: [],
  screenshots: {},
};

let browser;
const createdRuns = [];
try {
  const synthPdfPath = path.join(scratchDir, 'Northstar-Q1-2026-Retainer.pdf');
  const sourceBytes = await buildSyntheticRetainerPdf(synthPdfPath);
  report.syntheticSourceSha256 = sha256Hex(sourceBytes);

  browser = await chromium.launch({ headless: true });

  // =========================================================================
  // STEP 1: Visitor A Open Public Arrival (1280x800)
  // =========================================================================
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const pageA = await ctxA.newPage();

  let planRequestsCount = 0;
  const emailRequests = [];
  pageA.on('pageerror', (err) => report.pageErrors.push(String(err)));
  pageA.on('console', (msg) => {
    if (msg.type() === 'error') report.consoleErrors.push(msg.text());
  });
  pageA.on('request', (req) => {
    if (req.url().includes('/plan') && req.method() === 'POST') planRequestsCount++;
    if (req.url().includes('/email') && req.method() === 'POST') emailRequests.push(req.url());
  });

  await pageA.goto(STUDIO_URL, { waitUntil: 'networkidle', timeout: 45000 });
  await pageA.getByRole('heading', { name: 'AGENTIC PDF' }).waitFor({ state: 'visible', timeout: 15000 });
  await pageA.getByRole('button', { name: 'Upload PDF' }).waitFor({ state: 'visible', timeout: 15000 });
  const devBannerClose = pageA.locator('#rork-dev-banner button[aria-label*="Dismiss" i], #rork-dev-banner button:not(:has-text("Publish"))').first();
  if ((await devBannerClose.count()) > 0) await devBannerClose.click().catch(() => {});

  const arrivalMetrics = await pageA.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    clientKeyLength: (localStorage.getItem('studio:client-key') || '').length,
    clientKey: localStorage.getItem('studio:client-key') || '',
    bodyBg: getComputedStyle(document.body).backgroundColor,
    hasSignInWall: /sign in with google|private owner|owner sign-in/i.test(document.body.innerText),
  }));

  const shot1 = path.join(OUT_DIR, 'qa-1-arrival.png');
  await pageA.screenshot({ path: shot1 });
  report.screenshots.arrival = '.rork/web-verification/qa-1-arrival.png';

  // Verify Visitor A initial retained runs = 0 of 20 runs
  await pageA.getByRole('button', { name: 'Privacy & retained documents' }).click();
  await pageA.getByText('0 of 20 runs').waitFor({ state: 'visible', timeout: 15000 });
  await pageA.getByRole('button', { name: 'Close studio settings' }).click();

  report.steps.visitorAArrival = {
    openPublicAccessWithoutSignIn: !arrivalMetrics.hasSignInWall,
    horizontalOverflow: arrivalMetrics.horizontalOverflow,
    clientKeyGenerated: arrivalMetrics.clientKeyLength >= 24,
    bodyBg: arrivalMetrics.bodyBg,
    initialRetainedRuns: '0 of 20 runs',
  };
  const visitorAClientKey = arrivalMetrics.clientKey;

  // =========================================================================
  // STEP 2: Upload 2-Page Synthetic PDF + Consent Gate + Live Semantic NLP Draft
  // =========================================================================
  await pageA.locator('input[type="file"]').setInputFiles(synthPdfPath);
  const promptInput = pageA.getByRole('textbox', { name: 'Describe the changes you want in plain English' });
  await promptInput.waitFor({ state: 'visible', timeout: 20000 });

  const round1Prompt =
    'Roll this Q1 2026 retainer statement forward to Q2 2026 across both pages (April 15, 2026 statement date, Apr - Jun 2026 billing period, May 15, 2026 remittance due date, and updated Q2 engagement reference), and raise the Core Strategic Retainer Fee to $15,000.00 while recalculating the quarterly subtotal, 8% advisory tax, and total amount due.';

  await promptInput.fill(round1Prompt);
  await pageA.getByRole('button', { name: 'Prepare preview' }).click();

  // Verify Consent Dialog blocks /plan before Agree & Continue
  await pageA.getByRole('heading', { name: 'Before we analyze or reconstruct your PDF' }).waitFor({ state: 'visible', timeout: 10000 });
  await pageA.waitForTimeout(400);
  const planRequestsBeforeConsent = planRequestsCount;

  await pageA.getByRole('button', { name: 'Agree & Continue' }).click();

  // Wait for either clarifying questions or Prepare Actual PDF button
  const clarifyOrDraft = await Promise.race([
    pageA.getByRole('button', { name: 'Prepare Actual PDF' }).waitFor({ state: 'visible', timeout: 90000 }).then(() => 'draft'),
    pageA.getByRole('region', { name: 'Quick clarifying questions' }).waitFor({ state: 'visible', timeout: 90000 }).then(() => 'clarify'),
  ]);

  let clarificationAnswered = false;
  if (clarifyOrDraft === 'clarify') {
    clarificationAnswered = true;
    const blocks = pageA.locator('.clarify-question-block');
    const count = await blocks.count();
    for (let i = 0; i < count; i++) {
      const firstOpt = blocks.nth(i).locator('.clarify-opt-btn').first();
      if ((await firstOpt.count()) > 0) {
        await firstOpt.click();
      } else {
        await blocks.nth(i).locator('.clarify-custom-input').fill('Apply exact Q2 2026 values as requested');
      }
    }
    await pageA.getByRole('button', { name: /Confirm & Preview in Flipbook/i }).click();
    await pageA.getByRole('button', { name: 'Prepare Actual PDF' }).waitFor({ state: 'visible', timeout: 90000 });
  }

  const lockinSummaryText = await pageA.locator('.lockin-summary').innerText();
  const shot2 = path.join(OUT_DIR, 'qa-2-draft.png');
  await pageA.screenshot({ path: shot2 });
  report.screenshots.localDraft = '.rork/web-verification/qa-2-draft.png';

  report.steps.semanticPlanning = {
    planBlockedBeforeConsent: planRequestsBeforeConsent === 0,
    planRequestsAfterConsent: planRequestsCount,
    clarificationAnswered,
    lockinSummaryText,
  };

  // =========================================================================
  // STEP 3: Start Cloud Reconstruction + Test "Keep Running" Cancel Modal Dismiss
  // =========================================================================
  const startRespPromise1 = pageA.waitForResponse(
    (res) => res.url().includes('/runs/') && res.url().endsWith('/start') && res.request().method() === 'POST',
    { timeout: 30000 }
  );
  await pageA.getByRole('button', { name: 'Prepare Actual PDF' }).click();
  await startRespPromise1;

  const round1Url = new URL(pageA.url());
  const round1RunId = round1Url.searchParams.get('run');
  if (!round1RunId) throw new Error(`Expected ?run= param after starting Round 1, got ${pageA.url()}`);
  createdRuns.push({ runId: round1RunId, clientKey: visitorAClientKey });

  // Click Stop to verify confirmation modal & "Keep Running"
  const stopBtn1 = pageA.getByRole('button', { name: 'Stop', exact: true });
  await stopBtn1.waitFor({ state: 'visible', timeout: 15000 });
  await stopBtn1.click();

  const cancelHeading = pageA.getByRole('heading', { name: 'Cancel this PDF run?' });
  await cancelHeading.waitFor({ state: 'visible', timeout: 10000 });
  const cancelDialogText = await pageA.locator('dialog[aria-labelledby="cancel-run-title"]').innerText();

  const shot3 = path.join(OUT_DIR, 'qa-3-cancel-modal.png');
  await pageA.screenshot({ path: shot3 });
  report.screenshots.cancelModal = '.rork/web-verification/qa-3-cancel-modal.png';

  await pageA.getByRole('button', { name: 'Keep Running' }).click();
  await cancelHeading.waitFor({ state: 'hidden', timeout: 10000 });

  // =========================================================================
  // STEP 4: Wait for Live Railway pdfsurgeon Candidate Review -> Flip All Pages -> Approve -> Download
  // =========================================================================
  const approveBtn = pageA.getByRole('button', { name: 'Approve This PDF', exact: true });
  const reviewOutcome = await Promise.race([
    approveBtn.waitFor({ state: 'visible', timeout: 180000 }).then(() => 'review'),
    pageA.getByRole('button', { name: 'Reopen Saved Source' }).waitFor({ state: 'visible', timeout: 180000 }).then(() => 'stopped'),
  ]);
  if (reviewOutcome !== 'review') {
    const errStatus = await fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round1RunId)}`, {
      headers: { 'X-Studio-Client-Key': visitorAClientKey },
    }).then((r) => r.json());
    throw new Error(`Round 1 stopped before review: ${JSON.stringify(errStatus)}`);
  }

  // Wait for Page 1 of the actual candidate PDF to render, then flip to Page 2 so all pages are reviewed
  await pageA.getByText(/Actual candidate PDF · [12] of 2 pages rendered/i).waitFor({ state: 'visible', timeout: 60000 });
  const ackCheckbox = pageA.getByRole('checkbox', { name: 'I reviewed every page, including text, layout and calculations.' });
  const ackDisabledBeforeAllPagesRendered = await ackCheckbox.isDisabled();
  if ((await pageA.getByText(/Actual candidate PDF · 2 of 2 pages rendered/i).count()) === 0) {
    await pageA.getByRole('button', { name: 'Next page' }).click();
  }
  await pageA.getByText(/Actual candidate PDF · 2 of 2 pages rendered/i).waitFor({ state: 'visible', timeout: 60000 });

  const approveDisabledBeforeCheck = await approveBtn.isDisabled();
  const shot4 = path.join(OUT_DIR, 'qa-4-candidate-review.png');
  await pageA.screenshot({ path: shot4 });
  report.screenshots.candidateReview = '.rork/web-verification/qa-4-candidate-review.png';

  // Check acknowledgement & approve
  await ackCheckbox.check();
  const approveDisabledAfterCheck = await approveBtn.isDisabled();
  await approveBtn.click();

  const downloadLink = pageA.getByRole('link', { name: 'Download Finished PDF' });
  await downloadLink.waitFor({ state: 'visible', timeout: 60000 });

  const shot5 = path.join(OUT_DIR, 'qa-5-approved-final.png');
  await pageA.screenshot({ path: shot5 });
  report.screenshots.approvedFinal = '.rork/web-verification/qa-5-approved-final.png';

  // Trigger real browser download and verify SHA-256 + extracted text of both pages
  const [download] = await Promise.all([
    pageA.waitForEvent('download', { timeout: 30000 }),
    downloadLink.click(),
  ]);
  const downloadedPath = path.join(scratchDir, download.suggestedFilename() || 'approved-final.pdf');
  await download.saveAs(downloadedPath);
  const downloadedBytes = fs.readFileSync(downloadedPath);
  const downloadedSha256 = sha256Hex(downloadedBytes);

  // Fetch authoritative server status for Round 1 using Visitor A's session key
  const statusRes1 = await fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round1RunId)}`, {
    headers: { 'X-Studio-Client-Key': visitorAClientKey },
  });
  const statusJson1 = await statusRes1.json();

  const finalPageTexts = await extractPdfPageTexts(downloadedBytes);
  const shot6 = path.join(OUT_DIR, 'qa-6-downloaded-pdf-spread.png');
  await renderDownloadedPdfSpread(browser, downloadedBytes, shot6);
  report.screenshots.downloadedPdfSpread = '.rork/web-verification/qa-6-downloaded-pdf-spread.png';

  const p1Text = finalPageTexts[0] || '';
  const p2Text = finalPageTexts[1] || '';

  report.steps.round1Verification = {
    runId: round1RunId,
    cancelModalVerifiedAndDismissed: cancelDialogText.includes('permanently discards') && cancelDialogText.includes('original uploaded PDF stays intact'),
    ackDisabledBeforeAllPagesRendered,
    approveDisabledBeforeCheck,
    approveDisabledAfterCheck,
    serverStatus: statusJson1.status,
    candidateHash: statusJson1.candidateHash,
    downloadedSha256,
    sha256MatchesCandidateHash: downloadedSha256 === statusJson1.candidateHash,
    pageCount: finalPageTexts.length,
    page1ExtractedText: p1Text,
    page2ExtractedText: p2Text,
    assertions: {
      p1HasQ2Title: p1Text.includes('Q2 2026 Retainer Statement'),
      p1HasQ2Ref: p1Text.includes('NV-2026-Q2') && !p1Text.includes('NV-2026-Q1'),
      p1HasAprilDate: p1Text.includes('April 15, 2026') && !p1Text.includes('January 15, 2026'),
      p1HasQ2Period: p1Text.includes('Apr - Jun 2026') && !p1Text.includes('Jan - Mar 2026'),
      p2HasNewRetainerFee: p2Text.includes('$15,000.00') && !p2Text.includes('$12,000.00'),
      p2HasRecalculatedSubtotal: p2Text.includes('$18,500.00') && !p2Text.includes('$15,500.00'),
      p2HasRecalculatedTax: p2Text.includes('$1,480.00') && !p2Text.includes('$1,240.00'),
      p2HasRecalculatedTotal: p2Text.includes('$19,980.00') && !p2Text.includes('$16,740.00'),
      p2HasMayDueDate: p2Text.includes('May 15, 2026') && !p2Text.includes('February 14, 2026'),
    },
  };

  // =========================================================================
  // STEP 5: Visitor B Cross-Session Isolation Check (Fresh Context)
  // =========================================================================
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await ctxB.newPage();
  const visitorBResponses = [];
  pageB.on('response', (res) => {
    if (res.url().includes(`/runs/${round1RunId}`)) {
      visitorBResponses.push({ url: res.url(), status: res.status() });
    }
  });

  await pageB.goto(`${STUDIO_URL}/?run=${encodeURIComponent(round1RunId)}`, { waitUntil: 'networkidle', timeout: 45000 });
  await pageB.getByRole('button', { name: 'Upload PDF' }).waitFor({ state: 'visible', timeout: 15000 });
  await pageB.waitForTimeout(800);

  const visitorBBodyText = await pageB.evaluate(() => document.body.innerText);
  const visitorBClientKey = await pageB.evaluate(() => localStorage.getItem('studio:client-key') || '');

  // Check Visitor B's Privacy & retained documents -> must show 0 of 20 runs
  await pageB.getByRole('button', { name: 'Privacy & retained documents' }).click();
  await pageB.getByText('0 of 20 runs').waitFor({ state: 'visible', timeout: 15000 });
  const visitorBDialogText = await pageB.locator('dialog[aria-labelledby="privacy-title"]').innerText();
  await pageB.getByRole('button', { name: 'Close studio settings' }).click();

  // Also probe direct cross-session API calls with Visitor B's client key (read, candidate, cancel, delete)
  const crossProbes = {};
  for (const [label, method, suffix] of [
    ['getRun', 'GET', ''],
    ['getCandidate', 'GET', '/candidate'],
    ['getPdf', 'GET', '/pdf'],
    ['cancelRun', 'POST', '/cancel'],
    ['deleteRun', 'DELETE', ''],
  ]) {
    const r = await fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round1RunId)}${suffix}`, {
      method,
      headers: { 'X-Studio-Client-Key': visitorBClientKey },
    });
    crossProbes[label] = r.status;
  }

  await ctxB.close();

  report.steps.visitorBIsolation = {
    distinctSessionKeys: visitorAClientKey !== visitorBClientKey && visitorBClientKey.length >= 24,
    noSignInWallShown: !/sign in with google|private owner/i.test(visitorBBodyText),
    visitorBRunFetchStatuses: visitorBResponses,
    crossSessionApiProbesAll403: Object.values(crossProbes).every((code) => code === 403),
    crossProbes,
    visitorBRetainedRunsZero: visitorBDialogText.includes('0 of 20 runs'),
  };

  // =========================================================================
  // STEP 6: Visitor A Round 2 ("Make Another Edit") -> Confirmed Cancel & Discard Output
  // =========================================================================
  await pageA.getByRole('button', { name: 'Make Another Edit' }).click();
  const promptInput2 = pageA.getByRole('textbox', { name: 'Describe the changes you want in plain English' });
  await promptInput2.waitFor({ state: 'visible', timeout: 20000 });

  await promptInput2.fill('On page 1 change Net 30 Days to Net 15 Days.');
  await pageA.getByRole('button', { name: 'Prepare preview' }).click();

  const clarifyOrDraft2 = await Promise.race([
    pageA.getByRole('button', { name: 'Prepare Actual PDF' }).waitFor({ state: 'visible', timeout: 90000 }).then(() => 'draft'),
    pageA.getByRole('region', { name: 'Quick clarifying questions' }).waitFor({ state: 'visible', timeout: 90000 }).then(() => 'clarify'),
  ]);
  if (clarifyOrDraft2 === 'clarify') {
    const firstOpt = pageA.locator('.clarify-opt-btn').first();
    if ((await firstOpt.count()) > 0) await firstOpt.click();
    await pageA.getByRole('button', { name: /Confirm & Preview in Flipbook/i }).click();
    await pageA.getByRole('button', { name: 'Prepare Actual PDF' }).waitFor({ state: 'visible', timeout: 90000 });
  }

  const startRespPromise2 = pageA.waitForResponse(
    (res) => res.url().includes('/runs/') && res.url().endsWith('/start') && res.request().method() === 'POST',
    { timeout: 30000 }
  );
  await pageA.getByRole('button', { name: 'Prepare Actual PDF' }).click();
  await startRespPromise2;

  const round2RunId = new URL(pageA.url()).searchParams.get('run');
  if (!round2RunId || round2RunId === round1RunId) {
    throw new Error(`Expected distinct Round 2 runId, got ${round2RunId}`);
  }
  createdRuns.push({ runId: round2RunId, clientKey: visitorAClientKey });

  // Click Stop -> Confirm Cancel Run & Discard Output
  await pageA.getByRole('button', { name: 'Stop', exact: true }).click();
  await pageA.getByRole('heading', { name: 'Cancel this PDF run?' }).waitFor({ state: 'visible', timeout: 10000 });
  await pageA.getByRole('button', { name: 'Cancel Run & Discard Output' }).click();

  await pageA.getByRole('button', { name: 'Reopen Saved Source' }).waitFor({ state: 'visible', timeout: 20000 });
  await pageA.waitForTimeout(400);

  const cancelledBodyText = await pageA.evaluate(() => document.body.innerText);
  const shot7 = path.join(OUT_DIR, 'qa-7-cancelled-discarded.png');
  await pageA.screenshot({ path: shot7 });
  report.screenshots.cancelledDiscarded = '.rork/web-verification/qa-7-cancelled-discarded.png';

  // Verify server discarded partial/working/candidate output while preserving immutable source
  const [r2StatusRes, r2WorkingRes, r2CandidateRes, r2SourceRes] = await Promise.all([
    fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round2RunId)}`, { headers: { 'X-Studio-Client-Key': visitorAClientKey } }),
    fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round2RunId)}/working`, { headers: { 'X-Studio-Client-Key': visitorAClientKey } }),
    fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round2RunId)}/candidate`, { headers: { 'X-Studio-Client-Key': visitorAClientKey } }),
    fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round2RunId)}/source`, { headers: { 'X-Studio-Client-Key': visitorAClientKey } }),
  ]);
  const r2StatusJson = await r2StatusRes.json();

  // Also test "Reopen Saved Source" works cleanly in UI
  await pageA.getByRole('button', { name: 'Reopen Saved Source' }).click();
  await pageA.getByRole('textbox', { name: 'Describe the changes you want in plain English' }).waitFor({ state: 'visible', timeout: 20000 });

  report.steps.round2ConfirmedCancel = {
    runId: round2RunId,
    serverStatus: r2StatusJson.status,
    discardNoticeShown: cancelledBodyText.includes('Run cancelled and partial PDF output discarded. Your original uploaded PDF remains intact.'),
    workingEndpointStatus: r2WorkingRes.status,
    candidateEndpointStatus: r2CandidateRes.status,
    sourceEndpointStatus: r2SourceRes.status,
    reopenedSavedSourceCleanly: true,
  };

  // =========================================================================
  // STEP 7: Cleanup Visitor A Synthetic QA Runs via Delete Now -> Confirm Delete Now
  // =========================================================================
  await pageA.getByRole('button', { name: 'Close document', exact: true }).click();
  await pageA.getByRole('button', { name: 'Privacy & retained documents' }).waitFor({ state: 'visible', timeout: 15000 });
  await pageA.getByRole('button', { name: 'Privacy & retained documents' }).click();
  await pageA.getByText('2 of 20 runs').waitFor({ state: 'visible', timeout: 15000 });

  // Delete both synthetic QA runs via UI
  for (let i = 0; i < 2; i++) {
    const delBtn = pageA.getByRole('button', { name: 'Delete Now', exact: true }).first();
    await delBtn.waitFor({ state: 'visible', timeout: 10000 });
    await delBtn.click();
    await pageA.getByRole('button', { name: 'Confirm Delete Now' }).click();
    await pageA.waitForTimeout(500);
  }
  await pageA.getByText('0 of 20 runs').waitFor({ state: 'visible', timeout: 15000 });
  await pageA.getByRole('button', { name: 'Close studio settings' }).click();

  const [delCheck1, delCheck2] = await Promise.all([
    fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round1RunId)}`, { headers: { 'X-Studio-Client-Key': visitorAClientKey } }),
    fetch(`${RUNNER_URL}/runs/${encodeURIComponent(round2RunId)}`, { headers: { 'X-Studio-Client-Key': visitorAClientKey } }),
  ]);

  report.steps.cleanup = {
    retainedRunsAfterDeleteNow: '0 of 20 runs',
    round1DeletedStatus: delCheck1.status,
    round2DeletedStatus: delCheck2.status,
    emailRequestsSent: emailRequests.length,
  };

  await ctxA.close();
  console.log('=== LIVE BROWSER QA REPORT ===');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const item of createdRuns) {
    await fetch(`${RUNNER_URL}/runs/${encodeURIComponent(item.runId)}`, {
      method: 'DELETE',
      headers: { 'X-Studio-Client-Key': item.clientKey },
    }).catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
