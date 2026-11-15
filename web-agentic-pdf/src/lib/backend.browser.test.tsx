import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveRunCandidate, createBackgroundRun, updateRunNotificationEmail, type InitRunPayload } from './backend';
import { grantDataConsent, withdrawDataConsent } from './consent';
const token = (expiry: number) => `test.${btoa(JSON.stringify({ sub: 'synthetic-owner', exp: expiry }))}.not-a-real-signature`;
const payload: InitRunPayload = { documentName: 'Synthetic.pdf', apiBase: 'unused', userRequests: ['Rotate'], operations: [{ id: 'one', kind: 'rotate_page', page: 1, find: '', replace: '', rotateDegrees: 90, plainSummary: 'Rotate' }], totalPages: 1, returnUrl: 'https://agentic-pdf-edit.rork.app/' };
beforeEach(() => { localStorage.clear(); withdrawDataConsent(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); withdrawDataConsent(); });
describe('Consent at the actual authenticated transport boundary', () => {
  it('blocks new runs before any request when permission is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    expect(() => createBackgroundRun(payload)).toThrow('Processing permission'); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rechecks permission after token refresh and never sends the document request', async () => {
    localStorage.setItem('rork:access_token', token(1)); localStorage.setItem('rork:refresh_token', 'synthetic-refresh'); grantDataConsent();
    let resolve!: (response: Response) => void; const pending = new Promise<Response>(r => { resolve = r; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);
    const operation = createBackgroundRun(payload); const rejection = expect(operation).rejects.toThrow('Processing permission');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce()); withdrawDataConsent();
    resolve(Response.json({ access_token: token(Math.floor(Date.now() / 1000) + 3600) })); await rejection;
    expect(fetchSpy).toHaveBeenCalledOnce(); expect(String(fetchSpy.mock.calls[0][0])).toContain('/oauth/refresh');
  });
  it('honors consent withdrawal from another tab', () => {
    grantDataConsent(); localStorage.removeItem('agentic-pdf-data-consent-v2');
    window.dispatchEvent(new StorageEvent('storage', { key: 'agentic-pdf-data-consent-v2', newValue: null, storageArea: localStorage }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    expect(() => { void createBackgroundRun(payload).catch(() => undefined); }).toThrow('Processing permission'); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rechecks approval permission after a token refresh', async () => {
    localStorage.setItem('rork:access_token', token(1)); localStorage.setItem('rork:refresh_token', 'synthetic-refresh'); grantDataConsent();
    let resolve!: (response: Response) => void; const pending = new Promise<Response>(r => { resolve = r; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);
    const operation = approveRunCandidate('synthetic-id', 'a'.repeat(64), 3); const rejection = expect(operation).rejects.toThrow('Processing permission');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce()); withdrawDataConsent();
    resolve(Response.json({ access_token: token(Math.floor(Date.now() / 1000) + 3600) })); await rejection;
    expect(fetchSpy).toHaveBeenCalledOnce(); expect(String(fetchSpy.mock.calls[0][0])).toContain('/oauth/refresh');
  });
  it('permits notification removal without sharing new document data', async () => {
    localStorage.setItem('rork:access_token', token(Math.floor(Date.now() / 1000) + 3600));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ email: '' }));
    await updateRunNotificationEmail('synthetic-id', '', 'https://agentic-pdf-edit.rork.app/');
    expect(fetchSpy).toHaveBeenCalledOnce(); const [url, request] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/runs/synthetic-id/email'); expect(JSON.parse(String(request?.body)).email).toBe('');
  });
  it('sends a persistent session client key without requiring OAuth sign-in once consent is granted', async () => {
    grantDataConsent();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ runId: 'open-run' }));
    await createBackgroundRun(payload);
    await createBackgroundRun(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(fetchSpy.mock.calls[1][1]?.headers);
    const key = firstHeaders.get('X-Studio-Client-Key');
    expect(key).toMatch(/^[A-Za-z0-9_-]{24,128}$/);
    expect(secondHeaders.get('X-Studio-Client-Key')).toBe(key);
    expect(firstHeaders.get('Authorization')).toBeNull();
  });
});
