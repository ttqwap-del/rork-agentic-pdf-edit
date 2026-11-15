import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HTMLFlipBook from 'react-pageflip';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Eye,
  FileCheck2,
  FileText,
  Layers,
  Loader2,
  Lock,
  Mail,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import {
  DEFAULT_API_BASE,
  fetchHealth,
  fetchTemplates,
  type HealthInfo,
  type TemplateItem,
} from './api';
import {
  buildInteractivePreviewPdf,
  extractDocumentStructure,
  type ExtractedDocumentStructure,
  fetchServerTemplatePdfBytes,
  getDocument,
  type PDFDocumentProxy,
  sampleEarningsPdf,
  samplePdf,
  type TargetRegion,
  toPageTextSnapshots,
} from './document';
import {
  analyzeAndPlanEdits,
  type AnsweredClarification,
  type ClarifyingQuestion,
  type ConversationTurn,
} from './lib/ai-planner';
import {
  type ApprovedEditOperation,
  cancelBackgroundRun,
  approveRunCandidate,
  createBackgroundRun,
  fetchRunFinalPdfBytes,
  getBackgroundRunStatus,
  fetchRunPdf,
  type PublicRunStatus,
  startBackgroundRun,
  updateRunNotificationEmail,
  uploadRunSourcePdf,
} from './lib/backend';
import {
  grantDataConsent,
  hasDataConsent,
  VERIFIED_DATA_RECIPIENTS,
  withdrawDataConsent,
} from './lib/consent';
import './App.css';
import { safeRead } from './lib/auth';
import RetainedDocuments from './RetainedDocuments';
import { mergeRunStatus } from './lib/run-state';
import { hashPdf } from '../../agentic-pdf-runner/candidate';

type FlipHandle = {
  pageFlip: () => {
    flipNext: () => void;
    flipPrev: () => void;
    turnToPage: (n: number) => void;
  };
};

interface NoticeState {
  tone: 'info' | 'refused' | 'error' | 'ok';
  text: string;
}

const Page = forwardRef<
  HTMLDivElement,
  {
    pdf: PDFDocumentProxy;
    index: number;
    active: boolean;
    target: TargetRegion | null;
    busy: boolean;
    subtleFocus: boolean;
    reducedMotion: boolean;
    frameRatio: number;
    onError: (msg: string, pdf: PDFDocumentProxy) => void;
    onRendered: (pdf: PDFDocumentProxy, page: number) => void;
  }
>(function Page(
  { pdf, index, active, target, busy, subtleFocus, reducedMotion, frameRatio, onError, onRendered },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [naturalRatio, setNaturalRatio] = useState(frameRatio);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || !active) return;
    let disposed = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;

    void pdf
      .getPage(index + 1)
      .then((page) => {
        if (disposed) return;
        const natural = page.getViewport({ scale: 1 });
        setNaturalRatio(natural.width / natural.height);
        const scale = Math.min(2.2, Math.sqrt(3_200_000 / (natural.width * natural.height)));
        const viewport = page.getViewport({ scale });
        element.width = Math.floor(viewport.width);
        element.height = Math.floor(viewport.height);
        task = page.render({ canvas: element, viewport });
        return task.promise.then(() => { if (!disposed) onRendered(pdf, index + 1); });
      })
      .catch((err: { name?: string }) => {
        if (!disposed && err?.name !== 'RenderingCancelledException') {
          onError('This page could not be rendered in browser preview.', pdf);
        }
      });

    return () => {
      disposed = true;
      task?.cancel();
      element.width = 0;
      element.height = 0;
    };
  }, [pdf, index, active, onError, onRendered]);

  const locked = target?.page === index + 1;

  // Compute subtle smooth zoom/pan toward the active region without harsh cropping
  const focusStyle = useMemo(() => {
    if (!locked || !target || !subtleFocus || reducedMotion) {
      return undefined;
    }
    const cx = target.bbox[0] + target.bbox[2] / 2;
    const cy = target.bbox[1] + target.bbox[3] / 2;
    const tx = Math.max(-7, Math.min(7, (0.5 - cx) * 16));
    const ty = Math.max(-8, Math.min(8, (0.5 - cy) * 18));
    return {
      transform: `scale(1.11) translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`,
    };
  }, [locked, target, subtleFocus, reducedMotion]);

  return (
    <div className="paper" ref={ref} data-density="soft">
      <div className="paper-zoom-stage" style={{ ...focusStyle, position: 'absolute', width: `${Math.min(100, naturalRatio / frameRatio * 100)}%`, height: `${Math.min(100, frameRatio / naturalRatio * 100)}%`, left: `${(100 - Math.min(100, naturalRatio / frameRatio * 100)) / 2}%`, top: `${(100 - Math.min(100, frameRatio / naturalRatio * 100)) / 2}%` }}>
        <canvas ref={canvasRef} aria-label={`Document page ${index + 1}`} />
        {!active && <div className="page-placeholder" />}
        {busy && !target && active && <div className="scan-line" />}
        {locked && target && (
          <div
            className={`target ${busy ? 'shimmer' : 'preview-focus'}`}
            style={{
              left: `${target.bbox[0] * 100}%`,
              top: `${target.bbox[1] * 100}%`,
              width: `${target.bbox[2] * 100}%`,
              height: `${target.bbox[3] * 100}%`,
            }}
          >
            <i />
            <i />
            <i />
            <i />
            {busy && <div className="pixel-field" />}
          </div>
        )}
      </div>
    </div>
  );
});

export default function App() {
  // Original & Preview PDF proxies
  const [originalPdf, setOriginalPdf] = useState<PDFDocumentProxy | null>(null);
  const [originalBytes, setOriginalBytes] = useState<Uint8Array | null>(null);
  const [previewPdf, setPreviewPdf] = useState<PDFDocumentProxy | null>(null);
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [docStructure, setDocStructure] = useState<ExtractedDocumentStructure | null>(null);
  const [storageRefresh, setStorageRefresh] = useState(0);
  const [artifactRetry, setArtifactRetry] = useState(0);
  const [artifactError, setArtifactError] = useState('');
  const [loadedFinalId, setLoadedFinalId] = useState('');
  const [loadedCandidate, setLoadedCandidate] = useState<{ runId: string; hash: string; version: number } | null>(null);
  const [renderedCandidatePages, setRenderedCandidatePages] = useState<number[]>([]);
  const [candidateRenderFailed, setCandidateRenderFailed] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [approvingCandidate, setApprovingCandidate] = useState(false);
  const [pageRatio, setPageRatio] = useState(612 / 792);
  const [offline, setOffline] = useState(false);
  const [showingPreview, setShowingPreview] = useState(false);

  const [name, setName] = useState('');
  const [activeTemplate, setActiveTemplate] = useState<TemplateItem | null>(null);

  const [mode, setMode] = useState<'single' | 'spread'>('spread');
  const [page, setPage] = useState(0);
  const [subtleFocus, setSubtleFocus] = useState(true);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [reduced, setReduced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Opening PDF…');
  const [drag, setDrag] = useState(false);

  // Engine & Templates
  const endpoint = DEFAULT_API_BASE;
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);

  // Email notification state (shared from Arrival -> Preview -> Cloud Run)
  const [notifyEmail, setNotifyEmail] = useState(
    () => safeRead('agentic-notify-email') || '',
  );
  const [emailSavedFeedback, setEmailSavedFeedback] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

  // Conversational Clarification & Draft Preview state
  const [prompt, setPrompt] = useState('');
  const [planningBusy, setPlanningBusy] = useState(false);
  const [rewrittenRequests, setRewrittenRequests] = useState<string[]>([]);
  const [assistantSummary, setAssistantSummary] = useState('');
  const [pendingQuestions, setPendingQuestions] = useState<ClarifyingQuestion[]>([]);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [answeredHistory, setAnsweredHistory] = useState<AnsweredClarification[]>([]);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [plannedOps, setPlannedOps] = useState<ApprovedEditOperation[]>([]);
  const [focalPages, setFocalPages] = useState<number[]>([]);
  const [target, setTarget] = useState<TargetRegion | null>(null);

  // Locked-In Cloud Run state (3 progress bars + live auto-turn)
  const [lockingIn, setLockingIn] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [activeRun, setActiveRun] = useState<PublicRunStatus | null>(null);
  const [finalDownloadUrl, setFinalDownloadUrl] = useState('');
  const [outName, setOutName] = useState('');

  // Consent & Notices
  const [consentGranted, setConsentGranted] = useState<boolean>(() => hasDataConsent());
  const [notice, setNotice] = useState<NoticeState | null>(null);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const bookRef = useRef<FlipHandle>(null);
  const settingsDialogRef = useRef<HTMLDialogElement>(null);
  const templatesDialogRef = useRef<HTMLDialogElement>(null);
  const consentDialogRef = useRef<HTMLDialogElement>(null);
  const cancelDialogRef = useRef<HTMLDialogElement>(null);
  const pendingConsentActionRef = useRef<(() => void) | null>(null);
  const originalPdfRef = useRef<PDFDocumentProxy | null>(null);
  const previewPdfRef = useRef<PDFDocumentProxy | null>(null);
  const candidatePdfRef = useRef<PDFDocumentProxy | null>(null);
  const planningAbortRef = useRef<AbortController | null>(null);
  const stopSubmissionRef = useRef(false);
  const mountedRef = useRef(true);

  const displayedPdf = showingPreview && previewPdf ? previewPdf : originalPdf;
  const isRunExecuting =
    lockingIn || approvingCandidate ||
    Boolean(activeRun && (activeRun.status === 'queued' || activeRun.status === 'running'));
  const isRunCompleted = Boolean(activeRun && activeRun.status === 'done');
  const isCandidateLoaded = Boolean(activeRun?.status === 'review' && loadedCandidate?.runId === activeRun.runId && loadedCandidate?.hash === activeRun.candidateHash && loadedCandidate?.version === activeRun.artifactVersion && previewPdf);
  const canReviewCandidate = isCandidateLoaded && showingPreview && !loading && !artifactError && !candidateRenderFailed && renderedCandidatePages.length === activeRun?.totalPages;

  const narrow = size.width < 760;
  const hasStage = Boolean(displayedPdf || activeTemplate || activeRun);
  const total = displayedPdf?.numPages || activeTemplate?.pages || activeRun?.totalPages || 0;
  const spread = mode === 'spread' && !narrow && Boolean(displayedPdf) && total > 1;

  const hasCardsBelow =
    pendingQuestions.length > 0 || plannedOps.length > 0 || Boolean(activeRun);

  const pageHeight = Math.max(
    1,
    Math.min(
      size.height * (hasCardsBelow ? 0.52 : 0.58),
      Math.max(160, size.height - (hasCardsBelow ? 390 : 320)),
      ((size.width - (narrow ? 56 : 200)) / (spread ? 2 : 1)) / pageRatio,
      660,
    ),
  );
  const pageWidth = Math.floor(pageHeight * pageRatio);

  const maxUploadMb = Math.min(health?.max_upload_mb ?? 25, 25);
  const maxPages = Math.min(health?.max_pages ?? 50, 50);
  useEffect(() => { let alive = true; if (displayedPdf) void displayedPdf.getPage(Math.min(page + 1, displayedPdf.numPages)).then(p => { const v = p.getViewport({ scale: 1 }); if (alive) setPageRatio(v.width / v.height); }).catch(() => undefined); return () => { alive = false; }; }, [displayedPdf, page]);
  useEffect(() => { return () => { if (finalDownloadUrl) URL.revokeObjectURL(finalDownloadUrl); }; }, [finalDownloadUrl]);
  useEffect(() => {
    if (!activeRun || ['done', 'error', 'cancelled'].includes(activeRun.status)) {
      cancelDialogRef.current?.close();
    }
  }, [activeRun]);

  const reportRenderError = useCallback((text: string, pdf: PDFDocumentProxy) => {
    setNotice({ tone: 'error', text });
    if (pdf === candidatePdfRef.current) { setCandidateRenderFailed(true); setReviewAcknowledged(false); setArtifactError('A candidate page failed to render. Retry loading before approving.'); }
  }, []);
  const reportPageRendered = useCallback((pdf: PDFDocumentProxy, pageNumber: number) => {
    if (pdf === candidatePdfRef.current) setRenderedCandidatePages(pages => pages.includes(pageNumber) ? pages : [...pages, pageNumber]);
  }, []);

  // Viewport & reduced motion listeners
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = () => setReduced(mq.matches);
    onMotionChange();
    mq.addEventListener('change', onMotionChange);
    return () => {
      window.removeEventListener('resize', onResize);
      mq.removeEventListener('change', onMotionChange);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopSubmissionRef.current = true;
      planningAbortRef.current?.abort();
      void originalPdfRef.current?.loadingTask.destroy();
      void previewPdfRef.current?.loadingTask.destroy();
    };
  }, []);

  // Persist email locally for convenience
  const handleEmailInputChange = (val: string) => {
    setNotifyEmail(val);
    setEmailSavedFeedback('');
    try {
      if (val.trim()) {
        localStorage.setItem('agentic-notify-email', val.trim());
      } else {
        localStorage.removeItem('agentic-notify-email');
      }
    } catch {
      // ignore
    }
  };

  // Probe engine health & templates silently
  const refreshBackendInfo = useCallback(async (base: string) => {
    try {
      const [h, tpl] = await Promise.all([
        fetchHealth(base).catch(() => null),
        fetchTemplates(base).catch(() => []),
      ]);
      setHealth(h);
      setTemplates(tpl);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshBackendInfo(endpoint);
  }, [endpoint, refreshBackendInfo]);

  // Smoothly turn flipbook to a 1-based page number
  const turnBinderToPage = useCallback(
    (oneBasedPage: number) => {
      if (!displayedPdf) return;
      const clampedIdx = Math.max(0, Math.min(displayedPdf.numPages - 1, oneBasedPage - 1));
      setPage(clampedIdx);
      try {
        bookRef.current?.pageFlip()?.turnToPage(clampedIdx);
      } catch {
        // FlipBook may be mounting
      }
    },
    [displayedPdf],
  );

  // Load original PDF bytes & extract structure
  const loadSourcePdfBytes = useCallback(
    async (data: Uint8Array): Promise<{ proxy: PDFDocumentProxy; structure: ExtractedDocumentStructure }> => {
      const next = await getDocument({
        data: data.slice(),
        canvasMaxAreaInBytes: 16_000_000,
      }).promise;
      let structure: ExtractedDocumentStructure;
      try { structure = await extractDocumentStructure(next); } catch (error) { await next.loadingTask.destroy(); throw error; }
      if (!mountedRef.current) { await next.loadingTask.destroy(); throw new DOMException('Document closed', 'AbortError'); }
      const prevOrig = originalPdfRef.current;
      const prevPrev = previewPdfRef.current;
      originalPdfRef.current = next;
      previewPdfRef.current = null;
      setOriginalPdf(next);
      setOriginalBytes(data);
      setPreviewPdf(null);
      setPreviewBytes(null);
      setShowingPreview(false);
      window.setTimeout(() => {
        void prevOrig?.loadingTask.destroy();
        void prevPrev?.loadingTask.destroy();
      }, 450);

      setDocStructure(structure);
      return { proxy: next, structure };
    },
    [],
  );

  // Load preview PDF bytes into preview proxy
  const loadPreviewPdfBytes = useCallback(async (data: Uint8Array, signal?: AbortSignal): Promise<PDFDocumentProxy> => {
    const next = await getDocument({
      data: data.slice(),
      canvasMaxAreaInBytes: 16_000_000,
    }).promise;
    if (signal?.aborted) { await next.loadingTask.destroy(); signal.throwIfAborted(); }
    const prev = previewPdfRef.current;
    previewPdfRef.current = next;
    setPreviewPdf(next);
    setPreviewBytes(data);
    setShowingPreview(true);
    window.setTimeout(() => {
      void prev?.loadingTask.destroy();
    }, 450);
    return next;
  }, []);

  // Resume background run from ?run=<runId> URL parameter if present
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const runIdFromUrl = params.get('run')?.trim();
    if (!runIdFromUrl) return;

    let cancelled = false;
    setLoading(true);
    setLoadingLabel('Reconnecting to your document run…');
    void getBackgroundRunStatus(runIdFromUrl)
      .then(async (status) => {
        if (cancelled) return;
        setActiveRun(status);
        setName(status.documentName || 'Document.pdf');
        setRewrittenRequests(status.userRequests || []);
        if (status.email) setNotifyEmail(status.email);

        if (status.status !== 'done') {
          const source = await fetchRunPdf(status.runId, 'source');
          if (!cancelled) await loadSourcePdfBytes(source.bytes);
        }
      })
      .catch((error) => {
        if (!cancelled) setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Could not reopen this run. It may be unassigned, deleted, or temporarily unavailable. Your saved jobs have not been reset.' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadSourcePdfBytes]);

  const activeRunId = activeRun?.runId;
  const runStatus = activeRun?.status;
  const artifactVersion = activeRun?.artifactVersion;
  const candidateHash = activeRun?.candidateHash;
  const requiresCandidateApproval = activeRun?.requiresCandidateApproval;
  const candidateTotalPages = activeRun?.totalPages;
  // One request at a time. Completion fetching is separate so a status update cannot cancel it.
  useEffect(() => {
    if (!activeRunId || !['queued', 'running', 'review', 'done'].includes(runStatus || '')) return;
    const controller = new AbortController(); let timer = 0; let failures = 0;
    const poll = async () => {
      try {
        const next = await getBackgroundRunStatus(activeRunId, controller.signal);
        if (controller.signal.aborted) return;
        failures = 0; setOffline(false); setActiveRun(current => current?.runId === activeRunId ? mergeRunStatus(current, next) : current);
        if (['error', 'cancelled'].includes(next.status) || (next.status === 'done' && next.emailStatus !== 'queued')) return;
      } catch { if (controller.signal.aborted) return; failures++; setOffline(true); }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), Math.min(15000, 1800 * (failures + 1)));
    };
    void poll(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [activeRunId, runStatus, activeRun?.emailStatus]);
  useEffect(() => {
    setLoadedCandidate(null); setReviewAcknowledged(false); setRenderedCandidatePages([]); setCandidateRenderFailed(false); candidatePdfRef.current = null;
    setLoadedFinalId(''); setFinalDownloadUrl('');
    if (!activeRunId || !artifactVersion || loading) return;
    if (!['running', 'review', 'done'].includes(runStatus || '')) return;
    if (runStatus === 'review') { setPreviewPdf(null); setPreviewBytes(null); setShowingPreview(false); }
    const controller = new AbortController(); setArtifactError('');
    void (async () => {
      try {
        const final = runStatus === 'done'; const reviewing = runStatus === 'review';
        const file = final ? await fetchRunFinalPdfBytes(activeRunId, controller.signal) : await fetchRunPdf(activeRunId, reviewing ? 'candidate' : 'working', controller.signal);
        controller.signal.throwIfAborted();
        if (reviewing || (final && requiresCandidateApproval)) {
          if (!candidateHash || await hashPdf(file.bytes) !== candidateHash) throw new Error('The downloaded PDF does not match the saved review candidate. Reload before continuing.');
          controller.signal.throwIfAborted();
        }
        const proxy = await loadPreviewPdfBytes(file.bytes, controller.signal);
        controller.signal.throwIfAborted();
        setTarget(null); setSubtleFocus(false); setPage(p => Math.min(p, proxy.numPages - 1));
        if (reviewing) {
          if (proxy.numPages !== candidateTotalPages) throw new Error('Candidate page count differs from the saved run. Approval is blocked.');
          candidatePdfRef.current = proxy;
          setLoadedCandidate({ runId: activeRunId, hash: candidateHash!, version: artifactVersion });
        }
        if (final) {
          setLoadedFinalId(activeRunId); setOutName(file.filename || 'document-edited-review.pdf');
          setFinalDownloadUrl(URL.createObjectURL(new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' })));
        }
      } catch (error) { if (!controller.signal.aborted) setArtifactError(error instanceof Error ? error.message : 'Saved PDF could not be loaded.'); }
    })();
    return () => controller.abort();
  }, [activeRunId, artifactVersion, runStatus, candidateHash, requiresCandidateApproval, candidateTotalPages, artifactRetry, loadPreviewPdfBytes, loading]);

  const navigate = useCallback(
    (direction: number) => {
      if (isRunExecuting || !displayedPdf) return;
      if (!spread || reduced) {
        const step = spread ? 2 : 1;
        const next = Math.max(0, Math.min(total - 1, page + direction * step));
        setPage(next);
        bookRef.current?.pageFlip()?.turnToPage(next);
      } else if (direction > 0) {
        bookRef.current?.pageFlip()?.flipNext();
      } else {
        bookRef.current?.pageFlip()?.flipPrev();
      }
    },
    [isRunExecuting, displayedPdf, spread, reduced, total, page],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input, textarea, dialog')) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigate(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigate(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  const resetDraftState = useCallback(() => {
    planningAbortRef.current?.abort();
    setRewrittenRequests([]);
    setAssistantSummary('');
    setPendingQuestions([]);
    setSelectedOptions({});
    setCustomAnswers({});
    setAnsweredHistory([]);
    setConversation([]);
    setPlannedOps([]);
    setFocalPages([]);
    setTarget(null);
    setShowingPreview(false);
    setActiveRun(null);
    setFinalDownloadUrl('');
    setOutName('');
    setPreviewPdf(null); setPreviewBytes(null); setLoadedFinalId(''); setArtifactError(''); setPlanningBusy(false);
    setLoadedCandidate(null); candidatePdfRef.current = null; setRenderedCandidatePages([]); setReviewAcknowledged(false); setCandidateRenderFailed(false);
    setPrompt('');
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
  }, []);

  async function openFile(file: File) {
    if (isRunExecuting || loading || planningBusy) return;
    setNotice(null);
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setNotice({ tone: 'error', text: 'Please choose a PDF document (.pdf).' });
      return;
    }
    if (file.size > maxUploadMb * 1024 * 1024) {
      setNotice({
        tone: 'error',
        text: `This PDF is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Please choose a PDF up to ${maxUploadMb} MB.`,
      });
      return;
    }

    setLoading(true);
    setLoadingLabel('Opening your PDF…');
    try {
      resetDraftState();
      setOriginalPdf(null); setOriginalBytes(null); setDocStructure(null); setActiveTemplate(null); setName('');
      const data = new Uint8Array(await file.arrayBuffer());
      const { proxy } = await loadSourcePdfBytes(data);
      setName(file.name);
      setActiveTemplate(null);
      setPage(0);

      if (proxy.numPages > maxPages) {
        setNotice({
          tone: 'info',
          text: `Opened ${proxy.numPages} pages locally. Note: deep reconstruction supports documents up to ${maxPages} pages.`,
        });
      }
      window.setTimeout(() => promptInputRef.current?.focus(), 90);
    } catch {
      setNotice({ tone: 'error', text: 'This PDF could not be opened safely. It may be damaged, encrypted, rotated, cropped, or beyond the 50-page limit. Try a normalized plain PDF copy.' });
    } finally {
      setLoading(false);
    }
  }

  async function openSampleEarnings() {
    if (isRunExecuting || loading || planningBusy) return;
    setLoading(true);
    setLoadingLabel('Preparing 3-month earnings statement…');
    setNotice(null);
    try {
      resetDraftState();
      setOriginalPdf(null); setOriginalBytes(null); setDocStructure(null); setActiveTemplate(null); setName('');
      const data = await sampleEarningsPdf();
      await loadSourcePdfBytes(data);
      setName('Northwind Advisory — 3-Month Earnings Statement.pdf');
      setActiveTemplate(null);
      setPage(0);
      window.setTimeout(() => promptInputRef.current?.focus(), 90);
    } catch {
      setNotice({ tone: 'error', text: 'Could not prepare the sample earnings statement.' });
    } finally {
      setLoading(false);
    }
  }

  async function openSampleAgreement() {
    if (isRunExecuting || loading || planningBusy) return;
    setLoading(true);
    setLoadingLabel('Preparing 6-page agreement…');
    setNotice(null);
    try {
      resetDraftState();
      setOriginalPdf(null); setOriginalBytes(null); setDocStructure(null); setActiveTemplate(null); setName('');
      const data = await samplePdf();
      await loadSourcePdfBytes(data);
      setName('Halvorsen — Services Agreement.pdf');
      setActiveTemplate(null);
      setPage(0);
      window.setTimeout(() => promptInputRef.current?.focus(), 90);
    } catch {
      setNotice({ tone: 'error', text: 'Could not prepare the sample agreement.' });
    } finally {
      setLoading(false);
    }
  }

  async function selectServerTemplate(tpl: TemplateItem) {
    if (isRunExecuting || loading || planningBusy || !tpl.ok) return;
    templatesDialogRef.current?.close();
    setNotice(null);
    resetDraftState();
    setOriginalPdf(null); setOriginalBytes(null); setDocStructure(null);
    setActiveTemplate(tpl);
    setName(`${tpl.name} (${tpl.key}.pdf)`);
    setPage(0);

    setLoading(true);
    setLoadingLabel(`Loading ${tpl.name} into the flipbook…`);
    try {
      const fetchedBytes = await fetchServerTemplatePdfBytes(endpoint, tpl);
      if (fetchedBytes) {
        await loadSourcePdfBytes(fetchedBytes);
      } else {
        throw new Error('Template PDF could not be loaded. Try the template again or upload a copy.');
      }
      window.setTimeout(() => promptInputRef.current?.focus(), 90);
    } catch (error) {
      setActiveTemplate(null); setName('');
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'The template did not load. No earlier document will be used.' });
    } finally {
      setLoading(false);
    }
  }

  // Gate external AI / cloud processing behind explicit privacy consent
  function requireConsentThen(action: () => void) {
    if (hasDataConsent()) {
      setConsentGranted(true);
      action();
      return;
    }
    pendingConsentActionRef.current = action;
    consentDialogRef.current?.showModal();
  }

  function handleApproveConsent() {
    grantDataConsent();
    setConsentGranted(true);
    consentDialogRef.current?.close();
    const next = pendingConsentActionRef.current;
    pendingConsentActionRef.current = null;
    if (next) next();
  }

  function handleDeclineConsent() {
    pendingConsentActionRef.current = null;
    consentDialogRef.current?.close();
    setNotice({
      tone: 'info',
      text: 'Your PDF stays local in your browser until you choose to enable AI preview and cloud editing.',
    });
  }

  const handleWithdrawConsent = useCallback(async () => {
    stopSubmissionRef.current = true;
    planningAbortRef.current?.abort(); pendingConsentActionRef.current = null;
    setConsentGranted(false); setPlanningBusy(false); setPlannedOps([]); setPreviewPdf(null); setPreviewBytes(null); setShowingPreview(false); setLoadedCandidate(null); setReviewAcknowledged(false); candidatePdfRef.current = null;
    settingsDialogRef.current?.close();
    try {
      if (activeRun) {
        const stopped = await cancelBackgroundRun(activeRun.runId);
        setActiveRun(current => mergeRunStatus(current, stopped));
        if (stopped.status === 'done') { const updated = await updateRunNotificationEmail(stopped.runId, '', `${location.origin}/`); setActiveRun(current => mergeRunStatus(current, updated)); }
      }
      setNotice({ tone: 'info', text: 'Further submissions are blocked and cancellation was requested. Already processed data and accepted emails cannot be recalled. Saved studio copies remain until Delete Now.' });
    } catch (error) { setNotice({ tone: 'error', text: `Permission withdrawn locally, but the server cancellation was not confirmed. Retry Stop or Delete Now. ${error instanceof Error ? error.message : ''}` }); }
  }, [activeRun]);
  useEffect(() => {
    const onWithdraw = () => { void handleWithdrawConsent(); };
    window.addEventListener('studio-consent-withdrawn', onWithdraw);
    return () => window.removeEventListener('studio-consent-withdrawn', onWithdraw);
  }, [handleWithdrawConsent]);

  // Run AI Clarification + Interactive Flipbook Preview Generation
  const runClarificationAndPreview = useCallback(
    async (userMessage: string, extraAnswers: AnsweredClarification[] = []) => {
      if (!docStructure || !originalBytes || !originalPdf) return;
      planningAbortRef.current?.abort();
      setNotice(null); setPlannedOps([]); setPreviewPdf(null); setPreviewBytes(null); setShowingPreview(false); setTarget(null); setPendingQuestions([]);
      setPlanningBusy(true);

      const controller = new AbortController();
      planningAbortRef.current = controller;

      const updatedAnswers = [...answeredHistory, ...extraAnswers];
      const updatedConversation: ConversationTurn[] = userMessage.trim()
        ? [...conversation, { role: 'user', text: userMessage.trim() }]
        : [...conversation];

      try {
        const effectiveStructure = docStructure;

        const plan = await analyzeAndPlanEdits({
          pdf: originalPdf,
          structure: effectiveStructure,
          documentName: name || 'Document.pdf',
          latestUserPrompt: userMessage.trim(),
          conversation: updatedConversation,
          answeredClarifications: updatedAnswers,
          existingRequests: rewrittenRequests,
          existingOperations: plannedOps,
          signal: controller.signal,
        });

        controller.signal.throwIfAborted();
        setRewrittenRequests(plan.rewrittenRequests);
        setAssistantSummary(plan.assistantSummary);
        setAnsweredHistory(updatedAnswers);
        setConversation([
          ...updatedConversation,
          { role: 'assistant', text: plan.assistantSummary },
        ]);

        if (plan.questions.length > 0) {
          setPendingQuestions(plan.questions);
          setSelectedOptions({});
          setCustomAnswers({});
          return;
        }

        // Zero ambiguity remaining -> build end-to-end interactive flipbook preview!
        setPendingQuestions([]);
        const hasPageActions = plan.operations.some(op => op.kind && op.kind !== 'text');
        setFocalPages(hasPageActions ? [] : plan.focalPages);

        if (originalBytes && plan.operations.length > 0) {
          const builtBytes = await buildInteractivePreviewPdf(originalBytes, plan.operations);
          controller.signal.throwIfAborted();
          const builtProxy = await loadPreviewPdfBytes(builtBytes, controller.signal);
          controller.signal.throwIfAborted();
          setPlannedOps(plan.operations);

          const leadOp = plan.operations[0];
          const firstPage = hasPageActions ? 1 : leadOp?.page || plan.focalPages[0] || 1;
          const clampedPageIdx = Math.min(builtProxy.numPages - 1, Math.max(0, firstPage - 1));
          setPage(clampedPageIdx);
          window.setTimeout(() => {
            try {
              bookRef.current?.pageFlip()?.turnToPage(clampedPageIdx);
            } catch {
              // ignore
            }
          }, 120);

          if (!hasPageActions && leadOp?.bbox) {
            setTarget({ page: firstPage, bbox: leadOp.bbox });
            setSubtleFocus(true);
          } else {
            setTarget(null);
          }

          // Only the PDF canvas is shown. Generated images never cover an approval draft.
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setNotice({
            tone: 'error',
            text:
              err instanceof Error
                ? err.message
                : 'Could not prepare your preview right now. Please try again.',
          });
        }
      } finally {
        if (planningAbortRef.current === controller) setPlanningBusy(false);
      }
    },
    [
      docStructure,
      activeTemplate,
      answeredHistory,
      conversation,
      originalPdf,
      originalBytes,
      name,
      rewrittenRequests,
      plannedOps,
      loadPreviewPdfBytes,
    ],
  );

  function handlePromptSubmit(event: React.FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || planningBusy || isRunExecuting || loading) return;

    // Quick page navigation shortcut
    const goMatch = text.match(/^(?:go to |show |open )?page (\d+)$/i);
    if (goMatch && displayedPdf) {
      const pNum = Number(goMatch[1]);
      if (pNum >= 1 && pNum <= total) {
        turnBinderToPage(pNum);
        setPrompt('');
        return;
      }
    }

    requireConsentThen(() => {
      setPrompt('');
      void runClarificationAndPreview(text);
    });
  }

  function handleConfirmClarifications() {
    if (pendingQuestions.length === 0 || planningBusy || pendingQuestions.some(q => !(customAnswers[q.id]?.trim() || selectedOptions[q.id]))) return;
    const newlyAnswered: AnsweredClarification[] = pendingQuestions.map((q) => {
      const custom = (customAnswers[q.id] || '').trim();
      const chosen = custom || selectedOptions[q.id] || '';
      return {
        questionPrompt: q.prompt,
        selectedAnswer: chosen,
      };
    });

    const summaryReply = newlyAnswered
      .map((a) => `${a.questionPrompt} -> ${a.selectedAnswer}`)
      .join('; ');

    requireConsentThen(() => {
      void runClarificationAndPreview(summaryReply, newlyAnswered);
    });
  }

  // Jump to a specific previewed page and focus its first edit
  function focusPreviewPage(pageNum: number) {
    setShowingPreview(true);
    turnBinderToPage(pageNum);
    const pageOp = plannedOps.find((o) => o.page === pageNum);
    if (pageOp?.bbox) {
      setTarget({ page: pageNum, bbox: pageOp.bbox });
      setSubtleFocus(true);
    }
  }

  // Prepare the actual candidate; a local draft is never final approval.
  async function handleLockInEdits() {
    if (plannedOps.length === 0 || !previewBytes || !originalBytes || !docStructure || planningBusy || lockingIn || isRunExecuting) return;
    if (notifyEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail.trim())) { setNotice({ tone: 'error', text: 'Enter a valid notification email or leave it empty.' }); return; }

    requireConsentThen(() => {
      void (async () => {
        stopSubmissionRef.current = false;
        setLockingIn(true);
        setNotice(null);
        let createdId = '';
        try {
          // Show source until an actual saved engine checkpoint is available.
          setShowingPreview(false); setPreviewPdf(null); setPreviewBytes(null); setTarget(null);
          const cleanReturnUrl = `${window.location.origin}${window.location.pathname}`;

          const created = await createBackgroundRun({
            documentName: name || 'Document.pdf',
            apiBase: endpoint,
            templateKey: !originalBytes && activeTemplate ? activeTemplate.key : undefined,
            templateTargets: activeTemplate?.targets,
            userRequests: rewrittenRequests,
            operations: plannedOps,
            pageTexts: docStructure ? toPageTextSnapshots(docStructure) : [],
            email: notifyEmail.trim() || undefined,
            returnUrl: cleanReturnUrl,
            totalPages: docStructure?.totalPages || activeTemplate?.pages || 1,
          });

          createdId = created.runId;
          setActiveRun(created);
          window.history.replaceState({}, '', `${window.location.pathname}?run=${encodeURIComponent(created.runId)}`);
          if (stopSubmissionRef.current || !hasDataConsent() || !mountedRef.current) throw new Error('Processing was stopped. Cancellation requested.');
          await uploadRunSourcePdf(created.runId, originalBytes);
          if (stopSubmissionRef.current || !hasDataConsent() || !mountedRef.current) throw new Error('Processing was stopped. Cancellation requested.');

          const started = await startBackgroundRun(created.runId);
          if (stopSubmissionRef.current || !hasDataConsent() || !mountedRef.current) throw new Error('Processing was stopped while starting. Cancellation requested.');
          setActiveRun(current => mergeRunStatus(current, started));
          setSubtleFocus(true);

          if (started.activePage >= 1) {
            turnBinderToPage(started.activePage);
          }
          if (started.activeRegion) {
            setTarget({ page: started.activePage, bbox: started.activeRegion });
          }

          window.history.replaceState(
            {},
            '',
            `${window.location.pathname}?run=${encodeURIComponent(started.runId)}`,
          );
        } catch (err) {
          let cancellationNote = '';
          if (createdId) {
            try { const stopped = await cancelBackgroundRun(createdId); setActiveRun(current => mergeRunStatus(current, stopped)); }
            catch { cancellationNote = ' The server state is uncertain. Use Stop or Delete Now before retrying.'; }
          }
          setNotice({ tone: 'error', text: (err instanceof Error ? err.message : 'Could not start this run.') + cancellationNote });
        } finally {
          setLockingIn(false);
        }
      })();
    });
  }

  async function handleApproveCandidate() {
    if (!activeRun || !loadedCandidate || !canReviewCandidate || !reviewAcknowledged || approvingCandidate) return;
    const reviewed = loadedCandidate;
    requireConsentThen(() => {
      void (async () => {
        setApprovingCandidate(true); setNotice(null);
        try {
          const approved = await approveRunCandidate(reviewed.runId, reviewed.hash, reviewed.version);
          if (!mountedRef.current) return;
          setActiveRun(current => mergeRunStatus(current, approved));
          setReviewAcknowledged(false);
        } catch (error) {
          if (mountedRef.current) setNotice({ tone: 'error', text: `${error instanceof Error ? error.message : 'Approval could not be confirmed.'} Your candidate is retained. Retry approval or reopen the saved run; no reconstruction is repeated.` });
        } finally { if (mountedRef.current) setApprovingCandidate(false); }
      })();
    });
  }

  async function handleSaveRunEmail(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = notifyEmail.trim();
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setNotice({ tone: 'error', text: 'Please enter a valid email address.' });
      return;
    }

    if (!activeRun) {
      setEmailSavedFeedback('Saved — the completion notification is sent only after you approve the actual PDF.');
      return;
    }

    const saveEmail = () => {
      void (async () => {
        setSavingEmail(true);
        try {
          const cleanReturnUrl = `${window.location.origin}${window.location.pathname}`;
          const updated = await updateRunNotificationEmail(
            activeRun.runId,
            trimmed,
            cleanReturnUrl,
          );
          setActiveRun(current => mergeRunStatus(current, updated));
          setEmailSavedFeedback(updated.emailNote || (trimmed ? `Saved ${trimmed} for completion alert.` : 'Notifications removed.'));
        } catch (err) {
          setNotice({
            tone: 'error',
            text: err instanceof Error ? err.message : 'Could not save notification email.',
          });
        } finally {
          setSavingEmail(false);
        }
      })();
    };
    if (trimmed) requireConsentThen(saveEmail); else saveEmail();
  }

  function requestStopCloudRun() {
    if (!activeRun || stoppingRun || ['done', 'error', 'cancelled'].includes(activeRun.status)) return;
    cancelDialogRef.current?.showModal();
  }

  async function handleConfirmStopCloudRun() {
    if (!activeRun || stoppingRun) return;
    setStoppingRun(true);
    stopSubmissionRef.current = true;
    try {
      const stopped = await cancelBackgroundRun(activeRun.runId);
      const prevPreview = previewPdfRef.current;
      previewPdfRef.current = null;
      candidatePdfRef.current = null;
      setPreviewPdf(null);
      setPreviewBytes(null);
      setShowingPreview(false);
      setLoadedCandidate(null);
      setRenderedCandidatePages([]);
      setReviewAcknowledged(false);
      setTarget(null);
      setArtifactError('');
      window.setTimeout(() => {
        void prevPreview?.loadingTask.destroy();
      }, 300);
      setActiveRun(current => mergeRunStatus(current, stopped));
      cancelDialogRef.current?.close();
      setNotice({
        tone: 'info',
        text: 'Run cancelled and partial PDF output discarded. Your original uploaded PDF remains intact.',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Cancellation was not confirmed. Please retry Stop or Delete Now.' });
    } finally {
      setStoppingRun(false);
    }
  }

  function triggerLocalDownload() {
    if (activeRun && (activeRun.status !== 'done' || loadedFinalId !== activeRun.runId)) return;
    if (finalDownloadUrl) { const link = document.createElement('a'); link.href = finalDownloadUrl; link.download = outName || 'document-edited-review.pdf'; link.click(); return; }
    const data = showingPreview && previewBytes ? previewBytes : originalBytes;
    if (!data) return;
    const blobUrl = URL.createObjectURL(
      new Blob([data.slice().buffer as ArrayBuffer], { type: 'application/pdf' }),
    );
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = showingPreview ? `DRAFT-NOT-REDACTED-${name || 'document.pdf'}` : name || 'document.pdf';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
  }

  function openPrivacy() { setStorageRefresh(n => n + 1); settingsDialogRef.current?.showModal(); }

  function closeDocument() {
    if (isRunExecuting || loading) return;
    resetDraftState();
    setOriginalPdf(null);
    setOriginalBytes(null);
    setPreviewPdf(null);
    setPreviewBytes(null);
    setDocStructure(null);
    setActiveTemplate(null);
    setName('');
    setPage(0);
    setNotice(null);
    void originalPdfRef.current?.loadingTask.destroy();
    void previewPdfRef.current?.loadingTask.destroy();
    originalPdfRef.current = null;
    previewPdfRef.current = null;
  }

  async function startAnotherRoundOnVerifiedPdf() {
    if (!activeRun || loadedFinalId !== activeRun.runId || !previewBytes) return;
    setLoading(true);
    try { await loadSourcePdfBytes(previewBytes); resetDraftState(); setActiveTemplate(null); window.setTimeout(() => promptInputRef.current?.focus(), 80); }
    catch (error) { setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'The finished PDF could not be prepared for another round.' }); }
    finally { setLoading(false); }
  }
  async function returnToSavedSource() {
    if (!activeRun) return;
    setLoading(true);
    try {
      if (activeRun.status === 'review') {
        const stopped = await cancelBackgroundRun(activeRun.runId); setActiveRun(current => mergeRunStatus(current, stopped));
        if (stopped.status !== 'cancelled') throw new Error('This candidate is no longer awaiting review. Reopen the saved run before changing it.');
      }
      const file = await fetchRunPdf(activeRun.runId, 'source'); await loadSourcePdfBytes(file.bytes); resetDraftState(); setNotice({ tone: 'info', text: 'Original saved source reopened. Describe and review the changes again; uncertain work will not be replayed automatically.' });
    }
    catch (error) { setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'No saved source is available. Close this view and reopen your local PDF.' }); }
    finally { setLoading(false); }
  }

  const promptPlaceholder =
    plannedOps.length > 0
      ? 'Ask for any tweak in plain English (or prepare the actual PDF above)…'
      : 'Describe every change you want in plain English — e.g. double my earnings and update to the last 3 months';

  return (
    <main
      className={`studio ${hasStage ? 'has-document' : ''} ${drag ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!isRunExecuting) setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const file = e.dataTransfer.files[0];
        if (file) void openFile(file);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
          e.target.value = '';
        }}
      />

      {!hasStage ? (
        <section className="arrival" aria-label="Open a PDF">
          <div className="emblem">
            <img src="/icon.png" alt="Sculptural folded paper" />
          </div>
          <h1>AGENTIC PDF</h1>
          <p className="tagline">Precision, without the noise.</p>

          <button
            className="upload-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
          >
            {loading ? <Loader2 className="spin" size={22} /> : <Upload size={22} />}
            <span />
            {loading ? loadingLabel : 'Upload PDF'}
          </button>

          <p className="drop-hint">
            Or drop your document anywhere · up to {maxUploadMb} MB, {maxPages} pages
          </p>

          <div className="arrival-links">
            <button
              className="sample-link"
              onClick={() => void openSampleEarnings()}
              disabled={loading}
            >
              Sample 3-month earnings statement <ArrowUpRight size={13} />
            </button>
            <span className="link-dot" aria-hidden="true">
              ·
            </span>
            <button
              className="sample-link"
              onClick={() => void openSampleAgreement()}
              disabled={loading}
            >
              Sample 6-page agreement <ArrowUpRight size={13} />
            </button>
            <span className="link-dot" aria-hidden="true">
              ·
            </span>
            <button
              className="sample-link"
              onClick={() => templatesDialogRef.current?.showModal()}
              disabled={loading}
            >
              <Layers size={13} /> Point-of-truth templates (
              {templates.filter((t) => t.ok).length}) <ArrowUpRight size={13} />
            </button>
          </div>

          <aside className="craft-disclaimer-card" aria-label="Precision editing timeframe and email alert">
            <div className="craft-disclaimer-head">
              <Clock size={15} />
              <span>One-of-a-kind deep reconstruction · 15 minutes to 1 hour</span>
            </div>
            <p className="craft-disclaimer-body">
              Clarify your request, inspect a local draft, then prepare the actual PDF for approval.
              Allow 15–60 minutes depending on the document; simple jobs can finish sooner.
              Draft overlays are not secure redaction. Review every reconstructed page before
              approving. Completion emails are sent only after approval, with a configured sender.
            </p>
            <div className="arrival-email-row">
              <Mail size={15} className="arrival-mail-icon" />
              <input
                type="email"
                value={notifyEmail}
                onChange={(e) => handleEmailInputChange(e.target.value)}
                placeholder="Optional: your@email.com for completion notification"
                aria-label="Email address for completion notification"
              />
              {/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail.trim()) && (
                <span className="arrival-email-saved">
                  <Check size={12} /> Address valid
                </span>
              )}
            </div>
          </aside>
          <button className="sample-link" onClick={openPrivacy}>Privacy & retained documents</button>
        </section>
      ) : (
        <>
          <header className="brand">
            <button
              onClick={closeDocument}
              disabled={isRunExecuting || loading}
              aria-label="Close document and return home"
            >
              AGENTIC PDF
            </button>
          </header>

          <div className="quiet-actions">
            <button
              onClick={() => templatesDialogRef.current?.showModal()}
              aria-label="Browse point-of-truth templates"
              title="Point-of-truth templates"
              disabled={isRunExecuting}
            >
              <Layers size={17} />
            </button>
            <button
              onClick={openPrivacy}
              aria-label="Privacy and studio settings"
              title="Privacy & studio settings"
            >
              <ShieldCheck size={17} />
            </button>
            {finalDownloadUrl ? (
              <a
                className="quiet-link"
                href={finalDownloadUrl}
                download={outName || 'document-edited-review.pdf'}
                aria-label={`Download ${outName || 'finished PDF'}`}
                title={`Download ${outName || 'finished PDF'}`}
              >
                <Download size={17} />
              </a>
            ) : (
              <button
                onClick={triggerLocalDownload}
                aria-label="Download PDF"
                title="Download PDF"
                disabled={isRunExecuting || planningBusy || !originalBytes || Boolean(activeRun && loadedFinalId !== activeRun.runId)}
              >
                <Download size={17} />
              </button>
            )}
            <button onClick={closeDocument} aria-label="Close document" disabled={isRunExecuting || loading}>
              <X size={17} />
            </button>
          </div>

          <section className="workspace" aria-label="PDF document flipbook">
            <div
              className={`book-area ${spread ? 'spread' : 'single'}`}
              style={{
                width:
                  (displayedPdf
                    ? pageWidth * (spread ? 2 : 1)
                    : Math.min(540, size.width - 48)) + 16,
                height: pageHeight + 16,
              }}
            >
              {displayedPdf && (
                <button
                  className="page-nav previous"
                  aria-label="Previous page"
                  disabled={page === 0 || isRunExecuting}
                  onClick={() => navigate(-1)}
                >
                  <ChevronLeft size={22} />
                </button>
              )}

              <div className="book-cover">
                {displayedPdf ? (
                  spread && total > 1 ? (
                    <HTMLFlipBook
                      key={`${name}-${showingPreview ? 'preview' : 'orig'}-${pageWidth}-${total}-${isRunCompleted ? 'done' : 'live'}`}
                      ref={bookRef}
                      width={pageWidth}
                      height={Math.floor(pageHeight)}
                      size="fixed"
                      minWidth={100}
                      maxWidth={900}
                      minHeight={100}
                      maxHeight={1200}
                      startPage={Math.min(page, total - 1)}
                      drawShadow
                      flippingTime={reduced ? 1 : 860}
                      usePortrait={false}
                      startZIndex={10}
                      autoSize
                      maxShadowOpacity={0.32}
                      showCover={false}
                      mobileScrollSupport
                      clickEventForward
                      useMouseEvents={!isRunExecuting}
                      swipeDistance={30}
                      showPageCorners={!reduced && !isRunExecuting}
                      disableFlipByClick
                      className="flipbook"
                      style={{}}
                      onFlip={(event: { data: number }) => setPage(event.data)}
                    >
                      {Array.from({ length: total }, (_, index) => (
                        <Page
                          key={index}
                          pdf={displayedPdf}
                          index={index}
                          active={Math.abs(index - page) <= 3}
                          target={target}
                          busy={isRunExecuting || planningBusy}
                          subtleFocus={subtleFocus}
                          frameRatio={pageRatio} reducedMotion={reduced}
                          onError={reportRenderError} onRendered={reportPageRendered}
                        />
                      ))}
                    </HTMLFlipBook>
                  ) : (
                    <div style={{ width: pageWidth, height: pageHeight }}>
                      <Page
                        pdf={displayedPdf}
                        index={Math.min(page, Math.max(0, total - 1))}
                        active
                        target={target}
                        busy={isRunExecuting || planningBusy}
                        subtleFocus={subtleFocus}
                        frameRatio={pageRatio} reducedMotion={reduced}
                        onError={reportRenderError} onRendered={reportPageRendered}
                      />
                    </div>
                  )
                ) : (
                  <div
                    className="paper loading-sheet"
                    style={{
                      width: Math.min(540, size.width - 48),
                      height: pageHeight,
                    }}
                  >
                    <Loader2 className="spin" size={24} />
                    <p>{activeRun?.message || 'Preparing your document pages…'}</p>
                  </div>
                )}

                {spread && total > 1 && (
                  <div className="spine" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                )}
              </div>

              {displayedPdf && (
                <button
                  className="page-nav next"
                  aria-label="Next page"
                  disabled={page >= total - (spread ? 2 : 1) || isRunExecuting}
                  onClick={() => navigate(1)}
                >
                  <ChevronRight size={22} />
                </button>
              )}
            </div>

            {/* Clean Document Meta & Original / Preview + Single / Spread Switches */}
            <div
              className="document-meta"
              style={{
                maxWidth: displayedPdf
                  ? pageWidth * (spread ? 2 : 1) + 16
                  : Math.min(556, size.width - 32),
              }}
            >
              <div className="filename" title={name}>
                {isRunCompleted ? <FileCheck2 size={14} /> : <FileText size={14} />}
                <span>{name}</span>
              </div>

              <div className="meta-switches">
                {previewPdf && originalPdf && (!activeRun || activeRun.status === 'review') && (
                  <div className="view-switch" role="group" aria-label="Compare original and preview">
                    <button
                      type="button"
                      aria-pressed={!showingPreview}
                      onClick={() => { setShowingPreview(false); setReviewAcknowledged(false); }}
                    >
                      Original
                    </button>
                    <button
                      type="button"
                      aria-pressed={showingPreview}
                      onClick={() => setShowingPreview(true)}
                    >
                      {activeRun?.status === 'review' ? 'Actual PDF' : 'Draft'}
                    </button>
                  </div>
                )}

                {!narrow && displayedPdf && total > 1 && (
                  <div className="view-switch" role="group" aria-label="Binder layout">
                    <button
                      type="button"
                      aria-pressed={mode === 'single'}
                      disabled={isRunExecuting}
                      onClick={() => setMode('single')}
                    >
                      Single
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === 'spread'}
                      disabled={isRunExecuting}
                      onClick={() => setMode('spread')}
                    >
                      Spread
                    </button>
                  </div>
                )}

                {target && (
                  <button
                    type="button"
                    className={`focus-toggle ${subtleFocus ? 'on' : ''}`}
                    onClick={() => setSubtleFocus((v) => !v)}
                    title="Toggle subtle zoom on active edit area"
                  >
                    <Eye size={12} /> {subtleFocus ? 'Focused' : 'Full page'}
                  </button>
                )}
              </div>

              <div className="page-count">
                {spread
                  ? `${String(page + 1).padStart(2, '0')}–${String(Math.min(page + 2, total)).padStart(2, '0')}`
                  : String(Math.min(page + 1, Math.max(1, total))).padStart(2, '0')}
                <span> / {String(Math.max(1, total)).padStart(2, '0')}</span>
              </div>
            </div>
          </section>

          {/* Bottom Conversational Clarification, Preview Lock-In, OR 3-Bar Deep Progress Deck */}
          <section className="composer-area" aria-label="Edit studio controls">
            {/* Plain-English Rewritten Request Chips (Always clean, zero technical jargon) */}
            {rewrittenRequests.length > 0 && (
              <div className="request-pills" aria-label="Your clarified requests">
                {rewrittenRequests.map((reqText, idx) => (
                  <span key={`${idx}-${reqText}`} className="request-pill">
                    <Check size={12} />
                    <span>{reqText}</span>
                  </span>
                ))}
                {!activeRun && !planningBusy && (
                  <button
                    type="button"
                    className="reset-draft-btn"
                    onClick={resetDraftState}
                  >
                    <RotateCcw size={11} /> Start over
                  </button>
                )}
              </div>
            )}

            {/* Stage A: Zero-Ambiguity Clarifying Questions Card */}
            {pendingQuestions.length > 0 && !activeRun && (
              <div className="clarify-card" role="region" aria-label="Quick clarifying questions">
                <div className="clarify-header">
                  <Sparkles size={14} />
                  <span>{assistantSummary || 'A quick check so every detail is exact:'}</span>
                </div>

                <div className="clarify-questions-list">
                  {pendingQuestions.map((q) => (
                    <div key={q.id} className="clarify-question-block">
                      <p className="clarify-prompt">{q.prompt}</p>
                      <div className="clarify-options">
                        {q.options.map((opt) => {
                          const isSelected =
                            !customAnswers[q.id]?.trim() && selectedOptions[q.id] === opt.label;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              className={`clarify-opt-btn ${isSelected ? 'selected' : ''}`}
                              aria-pressed={isSelected}
                              onClick={() => {
                                setSelectedOptions((prev) => ({ ...prev, [q.id]: opt.label }));
                                setCustomAnswers((prev) => ({ ...prev, [q.id]: '' }));
                              }}
                            >
                              <strong>{opt.label}</strong>
                              {opt.description && <small>{opt.description}</small>}
                            </button>
                          );
                        })}
                      </div>
                      <input
                        type="text"
                        className="clarify-custom-input"
                        value={customAnswers[q.id] || ''}
                        onChange={(e) =>
                          setCustomAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                        }
                        aria-label={`Your answer: ${q.prompt}`}
                        placeholder="Or type your own exact preference…"
                      />
                    </div>
                  ))}
                </div>

                <div className="clarify-footer">
                  <button
                    type="button"
                    className="primary-ice-btn"
                    disabled={planningBusy || pendingQuestions.some(q => !(customAnswers[q.id]?.trim() || selectedOptions[q.id]))}
                    onClick={handleConfirmClarifications}
                  >
                    {planningBusy ? (
                      <>
                        <Loader2 className="spin" size={15} /> Building flipbook preview…
                      </>
                    ) : (
                      <>
                        Confirm & Preview in Flipbook <ArrowRight size={15} />
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Stage B: Local draft -> request the actual reconstruction candidate */}
            {plannedOps.length > 0 && previewBytes && pendingQuestions.length === 0 && !activeRun && (
              <div className="lockin-card" role="region" aria-label="Review local draft and prepare actual PDF">
                <div className="lockin-copy">
                  <p className="lockin-summary">
                    {assistantSummary}
                    <span className="plate-note"> · Local draft only, not for final approval. Original text may remain underneath overlays. Prepare the actual PDF to review and approve the exact download. Not secure redaction.</span>
                  </p>
                  {focalPages.length > 0 && (
                    <div className="focal-page-pills">
                      <span className="focal-label">Updated pages:</span>
                      {focalPages.map((pNum) => (
                        <button
                          key={pNum}
                          type="button"
                          className={`focal-pill ${page + 1 === pNum ? 'current' : ''}`}
                          onClick={() => focusPreviewPage(pNum)}
                        >
                          Page {pNum}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="lockin-approve-btn"
                  disabled={lockingIn || planningBusy}
                  onClick={() => void handleLockInEdits()}
                >
                  {lockingIn ? (
                    <>
                      <Loader2 className="spin" size={15} /> Preparing…
                    </>
                  ) : (
                    <>
                      <FileText size={14} /> Prepare Actual PDF
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Stage C: Locked-In Cloud Execution & Completion (3 Natural-Language Progress Bars) */}
            {activeRun ? (
              <div className="three-bar-deck" role="status" aria-live="polite">
                <div className="deck-top-row">
                  <p className="deck-plain-status">{activeRun.message}</p>
                  <span className="deck-overall-pct">{activeRun.overallPct}%</span>
                </div>

                {offline && <p className="deck-email-note">Connection interrupted. Saved progress is shown; reconnecting automatically.</p>}
                <p className="deck-email-note">{loadedFinalId === activeRun.runId ? 'Finished PDF loaded · review text, layout and calculations before use.' : activeRun.status === 'review' ? isCandidateLoaded && showingPreview ? `Actual candidate PDF · ${renderedCandidatePages.length} of ${activeRun.totalPages} pages rendered. Flip through every page before approving.` : 'Loading the actual candidate. The source or draft shown here cannot be approved.' : activeRun.status === 'cancelled' ? 'Partial output was discarded · showing your untouched source PDF.' : activeRun.status === 'error' ? 'Processing stopped · showing your untouched source PDF.' : showingPreview ? 'Showing the latest saved working PDF — not a simulated edit animation.' : 'Showing the source while saved progress loads.'}</p>
                {artifactError && <p role="alert">{artifactError} <button className="secondary-glass-btn" onClick={() => setArtifactRetry(n => n + 1)}>Retry PDF load</button></p>}
                <div className="three-bars-stack">
                  <div className="bar-row">
                    <div className="bar-meta">
                      <span className={activeRun.phase === 'planning' ? 'active' : ''}>
                        1. Planning
                      </span>
                      <span>{activeRun.bars.planning}%</span>
                    </div>
                    <div className="bar-track">
                      <div style={{ width: `${activeRun.bars.planning}%` }} />
                    </div>
                  </div>

                  <div className="bar-row">
                    <div className="bar-meta">
                      <span className={activeRun.phase === 'editing' ? 'active' : ''}>
                        2. Editing
                      </span>
                      <span>{activeRun.bars.editing}%</span>
                    </div>
                    <div className="bar-track">
                      <div style={{ width: `${activeRun.bars.editing}%` }} />
                    </div>
                  </div>

                  <div className="bar-row">
                    <div className="bar-meta">
                      <span className={activeRun.phase === 'verifying' ? 'active' : ''}>
                        3. PDF Integrity Check
                      </span>
                      <span>{activeRun.bars.verifying}%</span>
                    </div>
                    <div className="bar-track">
                      <div style={{ width: `${activeRun.bars.verifying}%` }} />
                    </div>
                  </div>
                </div>

                {activeRun.status === 'review' && (
                  <div className="candidate-review" role="region" aria-label="Approve the actual PDF">
                    <p className="deck-email-note">Only PDF integrity and page count were checked. Confirm the text, dates, totals and appearance yourself. Approval saves this exact PDF without further edits.</p>
                    <label className="candidate-acknowledgement">
                      <input type="checkbox" checked={reviewAcknowledged} disabled={!canReviewCandidate || approvingCandidate} onChange={event => setReviewAcknowledged(event.target.checked)} />
                      <span>I reviewed every page, including text, layout and calculations.</span>
                    </label>
                    <div className="deck-complete-buttons">
                      <button className="primary-ice-btn" disabled={!canReviewCandidate || !reviewAcknowledged || approvingCandidate} onClick={() => void handleApproveCandidate()}><Lock size={14} /> {approvingCandidate ? 'Saving approval…' : 'Approve This PDF'}</button>
                      <button className="secondary-glass-btn" disabled={loading || approvingCandidate} onClick={() => void returnToSavedSource()}>Revise From Original</button>
                    </div>
                  </div>
                )}
                {activeRun.status === 'done' ? (
                  <div className="deck-complete-actions">
                    {activeRun.emailNote && (
                      <p className="deck-email-note">{activeRun.emailNote}</p>
                    )}
                    {activeRun.email && <button type="button" className="secondary-glass-btn" disabled={savingEmail} onClick={() => {
                      setSavingEmail(true);
                      void updateRunNotificationEmail(activeRun.runId, '', `${location.origin}/`).then(updated => { setActiveRun(current => mergeRunStatus(current, updated)); handleEmailInputChange(''); }).catch(error => setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Could not remove notifications. Please retry.' })).finally(() => setSavingEmail(false));
                    }}>Remove Email</button>}
                    <div className="deck-complete-buttons">
                      {finalDownloadUrl ? (
                        <a
                          href={finalDownloadUrl}
                          download={outName || 'document-edited-review.pdf'}
                          className="primary-ice-btn"
                        >
                          <Download size={15} /> Download Finished PDF
                        </a>
                      ) : (
                        <button
                          type="button"
                          className="primary-ice-btn"
                          disabled
                        >
                          <Loader2 className="spin" size={15} /> Loading Finished PDF
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary-glass-btn"
                        disabled={loading || loadedFinalId !== activeRun.runId}
                        onClick={() => void startAnotherRoundOnVerifiedPdf()}
                      >
                        Make Another Edit
                      </button>
                    </div>
                  </div>
                ) : activeRun.status === 'error' || activeRun.status === 'cancelled' ? (
                  <div className="deck-complete-actions">
                    <div className="deck-complete-buttons">
                      <button
                        type="button"
                        className="primary-ice-btn"
                        disabled={loading}
                        onClick={() => void returnToSavedSource()}
                      >
                        Reopen Saved Source
                      </button>
                    </div>
                  </div>
                ) : (
                  <form className="deck-email-form" onSubmit={(e) => void handleSaveRunEmail(e)}>
                    <div className="deck-email-input-wrap">
                      <Mail size={14} />
                      <input
                        type="email"
                        value={notifyEmail}
                        onChange={(e) => handleEmailInputChange(e.target.value)}
                        placeholder="Completion email after actual PDF approval"
                        aria-label="Email address for completion link"
                      />
                    </div>
                    <button
                      type="submit"
                      className="deck-notify-btn"
                      disabled={savingEmail}
                    >
                      {savingEmail ? 'Saving…' : !notifyEmail.trim() ? 'Remove Email' : activeRun.email ? 'Update Email' : 'Notify Me'}
                    </button>
                    <button
                      type="button"
                      className="deck-stop-btn"
                      disabled={stoppingRun}
                      onClick={requestStopCloudRun}
                    >
                      Stop
                    </button>
                  </form>
                )}

                {(emailSavedFeedback || (activeRun.status !== 'done' && activeRun.emailNote)) && (
                  <p className="deck-email-note">
                    {emailSavedFeedback || activeRun.emailNote}
                  </p>
                )}
              </div>
            ) : (
              /* Conversational Plain-English Prompt Bar */
              <>
                <form className="composer" onSubmit={handlePromptSubmit}>
                  <div className="input-row">
                    <input
                      ref={promptInputRef}
                      type="text"
                      value={prompt}
                      disabled={planningBusy || loading || !docStructure}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={promptPlaceholder}
                      aria-label="Describe the changes you want in plain English"
                    />
                    <button
                      className="send"
                      type="submit"
                      disabled={planningBusy || loading || !docStructure || !prompt.trim()}
                      aria-label="Prepare preview"
                    >
                      {planningBusy ? (
                        <Loader2 className="spin" size={16} />
                      ) : (
                        <ArrowRight size={17} />
                      )}
                    </button>
                  </div>
                </form>

                <div className="keyboard-hint">
                  {planningBusy
                    ? 'Reading your document carefully and preparing your plain-English preview…'
                    : plannedOps.length > 0
                      ? 'Refine the local draft, then Prepare Actual PDF for a separate review and approval'
                      : 'Ask in everyday language · Any unclear detail is clarified before editing begins'}
                </div>
              </>
            )}
          </section>
        </>
      )}

      {/* Cancel In-Progress Run Confirmation Dialog */}
      <dialog ref={cancelDialogRef} className="engine-dialog" aria-labelledby="cancel-run-title">
        <div className="dialog-body">
          <button
            type="button"
            className="dialog-close"
            disabled={stoppingRun}
            onClick={() => cancelDialogRef.current?.close()}
            aria-label="Close cancel confirmation"
          >
            <X size={17} />
          </button>
          <div className="connection-icon warning-icon">
            <AlertTriangle size={21} />
          </div>
          <h2 id="cancel-run-title">Cancel this PDF run?</h2>
          <p>
            Stopping now cancels background reconstruction and permanently discards any partial or
            unapproved PDF output from this run. Your original uploaded PDF stays intact so you can
            start over whenever you are ready.
          </p>
          <div className="cancel-dialog-actions">
            <button
              type="button"
              className="secondary-glass-btn"
              disabled={stoppingRun}
              onClick={() => cancelDialogRef.current?.close()}
            >
              Keep Running
            </button>
            <button
              type="button"
              className="danger-confirm-btn"
              disabled={stoppingRun}
              onClick={() => void handleConfirmStopCloudRun()}
            >
              {stoppingRun ? (
                <>
                  <Loader2 className="spin" size={14} /> Cancelling…
                </>
              ) : (
                'Cancel Run & Discard Output'
              )}
            </button>
          </div>
        </div>
      </dialog>

      {/* Privacy & Data Consent Dialog (shown before first external AI / cloud processing) */}
      <dialog ref={consentDialogRef} className="engine-dialog wide-dialog" aria-labelledby="consent-title" onCancel={handleDeclineConsent}>
        <div className="dialog-body">
          <button
            type="button"
            className="dialog-close"
            onClick={handleDeclineConsent}
            aria-label="Close privacy prompt"
          >
            <X size={17} />
          </button>
          <div className="connection-icon">
            <ShieldCheck size={22} />
          </div>
          <h2 id="consent-title">Before we analyze or reconstruct your PDF</h2>
          <p>
            To clarify your requests, preview updated pages, run deep reconstruction in the
            background, and send optional completion emails, relevant document pages and text are
            processed by these services:
          </p>

          <ul className="recipient-list">
            {VERIFIED_DATA_RECIPIENTS.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.purpose}</span>
              </li>
            ))}
          </ul>

          <p className="connection-note">
            You can withdraw this permission at any time from the shield icon in the top-right
            corner of the workspace.
          </p>

          <div className="consent-actions">
            <button type="button" className="connect-button" onClick={handleApproveConsent}>
              Agree & Continue
            </button>
            <button type="button" className="disconnect" onClick={handleDeclineConsent}>
              Keep local only
            </button>
          </div>
        </div>
      </dialog>

      {/* Privacy & Studio Settings Dialog */}
      <dialog ref={settingsDialogRef} className="engine-dialog wide-dialog" aria-labelledby="privacy-title">
        <div className="dialog-body">
          <button
            type="button"
            className="dialog-close"
            onClick={() => settingsDialogRef.current?.close()}
            aria-label="Close studio settings"
          >
            <X size={17} />
          </button>
          <div className="connection-icon">
            <ShieldCheck size={21} />
          </div>
          <h2 id="privacy-title">Privacy & Retained Documents</h2>
          <p>
            Status:{' '}
            {consentGranted
              ? 'AI preview & background cloud reconstruction enabled.'
              : 'Local viewer only — AI & cloud processing paused.'}
          </p>

          {consentGranted && (
            <button
              type="button"
              className="withdraw-consent-btn"
              onClick={withdrawDataConsent}
            >
              Withdraw AI & Cloud Data Permission
            </button>
          )}

          <p className="connection-note">Processing uses only the approved reconstruction service. {health ? 'The service responded to its latest health check; this does not certify output quality.' : 'The service has not confirmed availability.'} Withdrawing permission stops new submissions and requests cancellation; already processed information cannot be recalled.</p>
          <RetainedDocuments refreshKey={storageRefresh} onDeleted={id => { if (activeRun?.runId === id) location.assign('/'); }} />
        </div>
      </dialog>

      {/* Point-of-Truth Templates Modal */}
      <dialog ref={templatesDialogRef} className="engine-dialog wide-dialog" aria-labelledby="templates-title">
        <div className="dialog-body">
          <button
            type="button"
            className="dialog-close"
            onClick={() => templatesDialogRef.current?.close()}
            aria-label="Close templates catalogue"
          >
            <X size={17} />
          </button>
          <h2 id="templates-title">Sample & Point-of-Truth Documents</h2>
          <p>
            Choose a multi-page sample or a live point-of-truth document to open directly inside the
            flipbook.
          </p>

          <div className="template-grid">
            <button
              type="button"
              className="template-card"
              onClick={() => {
                templatesDialogRef.current?.close();
                void openSampleEarnings();
              }}
            >
              <div className="tpl-top">
                <strong>3-Month Earnings Statement</strong>
              </div>
              <div className="tpl-meta">3 pages · Monthly figures, taxes & totals</div>
              <div className="tpl-target">Ideal for testing doubling earnings & shifting dates</div>
            </button>

            <button
              type="button"
              className="template-card"
              onClick={() => {
                templatesDialogRef.current?.close();
                void openSampleAgreement();
              }}
            >
              <div className="tpl-top">
                <strong>Halvorsen Master Agreement</strong>
              </div>
              <div className="tpl-meta">6 pages · Executive contract</div>
              <div className="tpl-target">Ideal for testing name, fee, and clause updates</div>
            </button>

            {templates.map((tpl) => (
              <button
                key={tpl.key}
                type="button"
                className="template-card"
                disabled={!tpl.ok}
                onClick={() => void selectServerTemplate(tpl)}
              >
                <div className="tpl-top">
                  <strong>{tpl.name}</strong>
                </div>
                <div className="tpl-meta">
                  {tpl.pages} {tpl.pages === 1 ? 'page' : 'pages'} · {tpl.size_mb} MB
                </div>
                {tpl.note && <div className="tpl-target">{tpl.note}</div>}
              </button>
            ))}
          </div>
        </div>
      </dialog>

      {notice && (
        <aside className={`notice tone-${notice.tone}`} role="status">
          <span className="notice-text">{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notice">
            <X size={15} />
          </button>
        </aside>
      )}

      {drag && (
        <div className="drop-overlay">
          <Upload size={34} />
          <h2>Drop PDF to open</h2>
          <p>Opens directly in your flipbook preview</p>
        </div>
      )}

      {loading && hasStage && (
        <div className="loading-badge">
          <Loader2 className="spin" size={16} /> {loadingLabel}
        </div>
      )}
    </main>
  );
}
