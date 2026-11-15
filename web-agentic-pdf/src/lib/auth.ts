const AUTH_URL = import.meta.env.EXPO_PUBLIC_RORK_AUTH_URL as string;
const APP_KEY = import.meta.env.EXPO_PUBLIC_RORK_APP_KEY as string;
const ACCESS = 'rork:access_token'; const REFRESH = 'rork:refresh_token'; const PKCE = 'studio:pkce'; const STATE = 'studio:oauth-state'; const CLIENT_KEY = 'studio:client-key';
let epoch = 0; let pendingRefresh: Promise<string | null> | null = null; let retryAfter = 0; let memoryClientKey: string | null = null;
const listeners = new Set<() => void>();
export const subscribeAuth = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const notify = () => listeners.forEach(fn => fn());
export function safeRead(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { throw new Error('Sign-in requires browser storage. Allow site storage and try again.'); } }
function remove(key: string) { try { localStorage.removeItem(key); } catch { /* Already unavailable. */ } }
export function identity(token: string | null): { id: string; exp: number } | null {
  try { const raw = token?.split('.')[1]; if (!raw) return null; const data = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: string; exp?: number }; return data.sub && data.exp ? { id: data.sub, exp: data.exp } : null; } catch { return null; }
}
export function sessionSnapshot() { return safeRead(ACCESS); }
export async function signOut() {
  epoch++; const refresh = safeRead(REFRESH); remove(ACCESS); remove(REFRESH); remove(PKCE); remove(STATE); retryAfter = 0; notify();
  if (refresh) void fetch(`${AUTH_URL}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_key: APP_KEY, refresh_token: refresh }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
}
export async function getAccessToken(rejected?: string): Promise<string | null> {
  const token = safeRead(ACCESS); const user = identity(token);
  if (token && token !== rejected && user && user.exp * 1000 > Date.now() + 60_000) return token;
  if (!pendingRefresh) pendingRefresh = refresh().finally(() => { pendingRefresh = null; });
  const next = await pendingRefresh;
  return rejected && identity(next)?.id !== identity(rejected)?.id ? null : next;
}
async function refresh() {
  const refreshToken = safeRead(REFRESH); if (!refreshToken || Date.now() < retryAfter) return null;
  const generation = epoch;
  const res = await fetch(`${AUTH_URL}/oauth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_key: APP_KEY, refresh_token: refreshToken }), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const body = res?.ok ? await res.json().catch(() => null) as { access_token?: string } | null : null;
  if (generation !== epoch || safeRead(REFRESH) !== refreshToken) return null;
  if (res?.status === 401) { await signOut(); return null; }
  if (!body?.access_token || !identity(body.access_token)) { retryAfter = Date.now() + 30_000; return null; }
  write(ACCESS, body.access_token); retryAfter = 0; notify(); return body.access_token;
}
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function exchange(code: string, state?: string | null) {
  const verifier = safeRead(PKCE); const expectedState = safeRead(STATE); const generation = epoch;
  if (!verifier || (state && state !== expectedState)) throw new Error('Sign-in session is invalid. Please try again.');
  const res = await fetch(`${AUTH_URL}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_key: APP_KEY, code, code_verifier: verifier }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error('Sign-in could not be completed. Please try again.');
  const data = await res.json() as { access_token: string; refresh_token: string };
  if (generation !== epoch) return;
  if (!identity(data.access_token) || !data.refresh_token) throw new Error('Invalid sign-in response.');
  write(REFRESH, data.refresh_token); write(ACCESS, data.access_token); remove(PKCE); remove(STATE); notify();
}
let callback: Promise<void> | null = null;
export function finishCallback(): Promise<void> {
  if (window.location.pathname !== '/auth/callback') return Promise.resolve();
  callback ??= (async () => {
    const params = new URLSearchParams(location.search); const code = params.get('code');
    if (!code) throw new Error('Sign-in was cancelled or no authorization was returned.');
    await exchange(code, params.get('state')); history.replaceState({}, '', '/');
  })();
  return callback;
}
export async function signIn(provider: 'google' | 'apple') {
  epoch++;
  const preview = location.hostname.endsWith('.rork.live') || location.hostname === 'localhost' || window.parent !== window;
  const popup = preview ? window.open('about:blank', 'studio-sign-in', 'width=500,height=650') : null;
  if (preview && !popup) throw new Error('Allow popups for this studio to sign in.');
  try {
    const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
    write(PKCE, verifier);
    const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const res = await fetch(`${AUTH_URL}/oauth/initiate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_key: APP_KEY, provider, code_challenge: challenge, target: 'web', env: preview ? 'preview' : 'production', ...(preview ? { app_path: 'web-agentic-pdf' } : {}) }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error('Sign-in is temporarily unavailable.');
    const { auth_url, state } = await res.json() as { auth_url: string; state: string };
    const parsed = new URL(auth_url); if (parsed.protocol !== 'https:') throw new Error('Invalid authorization address.');
    write(STATE, state);
    if (!popup) { location.assign(auth_url); return; }
    await new Promise<void>((resolve, reject) => {
      let exchanging = false;
      const cleanup = () => { window.removeEventListener('message', receive); clearInterval(timer); clearTimeout(deadline); popup.close(); };
      const receive = (event: MessageEvent) => {
        if (event.source !== popup || ![location.origin, new URL(AUTH_URL).origin].includes(event.origin) || event.data?.type !== 'rork_auth_callback' || exchanging) return;
        exchanging = true;
        if (typeof event.data.code !== 'string') { cleanup(); reject(new Error('Sign-in was cancelled.')); return; }
        void exchange(event.data.code, event.data.state).then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
      };
      const timer = window.setInterval(() => { if (popup.closed && !exchanging) { cleanup(); reject(new Error('Sign-in window was closed.')); } }, 500);
      const deadline = window.setTimeout(() => { cleanup(); reject(new Error('Sign-in timed out. Please try again.')); }, 180_000);
      window.addEventListener('message', receive); popup.location.href = auth_url;
    });
  } catch (error) { popup?.close(); remove(PKCE); remove(STATE); throw error; }
}
export function getStudioClientKey(): string {
  const existing = safeRead(CLIENT_KEY);
  if (existing && /^[A-Za-z0-9_-]{24,128}$/.test(existing)) return existing;
  const generated = b64(crypto.getRandomValues(new Uint8Array(24)));
  try {
    localStorage.setItem(CLIENT_KEY, generated);
    memoryClientKey = null;
    return generated;
  } catch {
    memoryClientKey ??= generated;
    return memoryClientKey;
  }
}
export async function authenticatedFetch(url: string, init: RequestInit = {}, beforeSend?: () => void) {
  const hasStoredAuth = Boolean(safeRead(ACCESS) || safeRead(REFRESH));
  const token = hasStoredAuth ? await getAccessToken() : null;
  const send = (access: string | null) => {
    beforeSend?.();
    const headers = new Headers(init.headers);
    headers.set('X-Studio-Client-Key', getStudioClientKey());
    if (access) headers.set('Authorization', `Bearer ${access}`);
    return fetch(url, { ...init, headers, credentials: 'omit', redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
  };
  const response = await send(token);
  if (response.status !== 401 || !token) return response;
  const next = await getAccessToken(token);
  return send(next);
}
window.addEventListener('storage', event => { if (event.key === ACCESS || event.key === REFRESH || event.key === null) { epoch++; notify(); } });
