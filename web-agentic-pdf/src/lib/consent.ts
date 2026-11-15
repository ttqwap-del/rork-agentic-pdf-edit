const CONSENT_STORAGE_KEY = 'agentic-pdf-data-consent-v2';
let sessionConsent: boolean | null = null;
export function assertDataConsent(): void {
  if (!hasDataConsent()) throw new Error('Processing permission is required. Your request has not been sent.');
}

export interface VerifiedDataRecipient {
  id: string;
  name: string;
  purpose: string;
}

/**
 * Actual verified external recipients that process document text/page images or
 * optional notification email addresses when the user chooses to analyze, preview,
 * or lock in edits.
 */
export const VERIFIED_DATA_RECIPIENTS: ReadonlyArray<VerifiedDataRecipient> = [
  {
    id: 'gemini-gateway',
    name: 'Google Gemini (via Rork AI & Vercel AI Gateway)',
    purpose:
      'Reads extracted text from every supported page to propose changes and ask clarifying questions. AI suggestions, dates and calculations still require your review.',
  },
  {
    id: 'cloud-pdf-runner',
    name: 'Cloud PDF Reconstruction Runner (Cloudflare Durable Storage & Railway pdfsurgeon)',
    purpose:
      'Processes approved edits in the background and retains source, working and finished PDFs until you choose Delete Now. Deletion removes studio copies; separate processing-provider retention is not controlled by this studio.',
  },
  {
    id: 'email-notifier',
    name: 'Completion Email Service (Resend, optional)',
    purpose:
      'Receives your email address only if you enter one, solely to send a link when your finished PDF is ready.',
  },
];

export function hasDataConsent(): boolean {
  if (sessionConsent !== null) return sessionConsent;
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY) === 'granted';
  } catch {
    return false;
  }
}

export function grantDataConsent(): void {
  sessionConsent = true;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
  } catch {
    // Ignore storage errors in restricted browsing contexts.
  }
}

window.addEventListener('storage', event => {
  if ((event.key === CONSENT_STORAGE_KEY && event.newValue !== 'granted') || event.key === null) {
    sessionConsent = false;
    window.dispatchEvent(new Event('studio-consent-withdrawn'));
  }
});

export function withdrawDataConsent(): void {
  sessionConsent = false;
  window.dispatchEvent(new Event('studio-consent-withdrawn'));
  try {
    window.localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // Ignore storage errors in restricted browsing contexts.
  }
}
