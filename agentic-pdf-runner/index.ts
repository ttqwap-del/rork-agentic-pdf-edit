import { RunCoordinator, StudioCatalog, type RunnerEnv } from './run-coordinator';
import { readJson, readLimited, safeReturnUrl, STUDIO_ORIGINS, validEmail, validateOperations } from './policy';
export { RunCoordinator, StudioCatalog };
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } }); }
async function digestHex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
async function resolvePrincipal(request: Request): Promise<{ userId: string | null; principalId: string | null }> {
  // X-Rork-User-Id is stripped/set by Rork's perimeter when a verified Rork OAuth token is supplied.
  const userId = request.headers.get('X-Rork-User-Id')?.trim() || null;
  if (userId) return { userId, principalId: userId };
  const clientKey = request.headers.get('X-Studio-Client-Key')?.trim() || '';
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(clientKey)) return { userId: null, principalId: null };
  return { userId: null, principalId: `client:${(await digestHex(clientKey)).slice(0, 40)}` };
}
export default {
  async fetch(request: Request, env: RunnerEnv): Promise<Response> {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Studio-Client-Key', 'Access-Control-Expose-Headers': 'Content-Disposition' });
    if (origin && STUDIO_ORIGINS.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
    // Local development may call the preview backend without opening public CORS to arbitrary sites.
    if (origin && /^http:\/\/localhost:\d+$/.test(origin)) headers.set('Access-Control-Allow-Origin', origin);
    const finish = (res: Response) => { const out = new Response(res.body, res); headers.forEach((v, k) => out.headers.set(k, v)); return out; };
    if (request.method === 'OPTIONS') return finish(new Response(null, { status: 204 }));
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health' || url.pathname === '/ping') return finish(json({ ok: true }));
      const { userId, principalId } = await resolvePrincipal(request);
      if (url.pathname === '/access' && request.method === 'GET') return finish(json({ userId, allowed: Boolean(principalId), publicAccess: true, configured: true }));
      if (!principalId) return finish(json({ error: 'Open Agentic PDF in your browser to start a studio session.' }, 401));
      const trusted = { 'X-Studio-Owner': principalId };
      const catalog = env.STUDIO_CATALOG.get(env.STUDIO_CATALOG.idFromName(principalId));
      const runStub = (id: string) => env.RUN_COORDINATOR.get(env.RUN_COORDINATOR.idFromName(id));
      const clientIp = request.headers.get('CF-Connecting-IP')?.trim();
      const ipCatalog = clientIp ? env.STUDIO_CATALOG.get(env.STUDIO_CATALOG.idFromName(`ip:${(await digestHex(clientIp)).slice(0, 32)}`)) : null;
      if (url.pathname === '/plan' && request.method === 'POST') {
        if (!env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY) return finish(json({ error: 'AI planning is not configured.' }, 503));
        const body = await readJson(request, 750_000);
        if (!Array.isArray(body.messages) || body.messages.length !== 2 || body.messages.some((m: unknown) => !m || typeof m !== 'object' || typeof (m as { content?: unknown }).content !== 'string')) throw new Error('Invalid planning request.');
        if (ipCatalog) {
          const ipBudget = await ipCatalog.fetch(new Request('https://catalog/ip-plan-check', { method: 'POST', headers: trusted }));
          if (!ipBudget.ok) return finish(ipBudget);
        }
        const budget = await catalog.fetch(new Request('https://catalog/planning-reservation', { method: 'POST', headers: trusted }));
        if (!budget.ok) return finish(budget);
        const upstream = await fetch('https://toolkit.rork.com/v2/vercel/v1/chat/completions', {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(50_000),
          headers: { Authorization: `Bearer ${env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'google/gemini-3.8-flash', temperature: 0.1, max_tokens: 16000, response_format: { type: 'json_object' }, messages: body.messages }),
        });
        if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return finish(json({ error: 'AI planning redirect rejected. No edits were guessed.' }, 502)); }
        if (!upstream.ok) { await upstream.body?.cancel(); return finish(json({ error: `AI planning is unavailable (${upstream.status}). No edits were guessed. Please retry.` }, 502)); }
        const bytes = await readLimited(upstream.body, 1_000_000);
        return finish(new Response(bytes, { headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.pathname === '/runs' && request.method === 'GET') {
        const res = await catalog.fetch(new Request('https://catalog/', { headers: trusted }));
        const { runs } = await res.json() as { runs: { id: string; created: number }[] };
        const items = await Promise.all(runs.map(async ({ id }) => {
          const status = await runStub(id).fetch(new Request('https://run/status', { headers: trusted }));
          return status.ok ? status.json() : null;
        }));
        return finish(json({ runs: items.filter(Boolean) }));
      }
      if (url.pathname === '/runs' && request.method === 'POST') {
        const body = await readJson(request);
        validateOperations(body.operations, Number(body.totalPages)); safeReturnUrl(body.returnUrl); validEmail(body.email);
        if (ipCatalog) {
          const ipRunBudget = await ipCatalog.fetch(new Request('https://catalog/ip-run-check', { method: 'POST', headers: trusted }));
          if (!ipRunBudget.ok) return finish(ipRunBudget);
        }
        // Server-issued identifiers; a caller cannot choose a legacy run to reinitialize.
        const runId = crypto.randomUUID().replace(/-/g, '');
        const reserved = await catalog.fetch(new Request(`https://catalog/${runId}`, { method: 'POST', headers: trusted }));
        if (!reserved.ok) return finish(reserved);
        const result = await runStub(runId).fetch(new Request('https://run/init', { method: 'POST', headers: { ...trusted, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, runId }) }));
        if (!result.ok) await catalog.fetch(new Request(`https://catalog/${runId}`, { method: 'DELETE', headers: trusted }));
        return finish(result);
      }
      const match = url.pathname.match(/^\/runs\/([a-zA-Z0-9_-]{6,36})(?:\/(source|working|start|email|cancel|pdf|candidate|approve))?$/);
      if (!match) return finish(json({ error: 'Not found.' }, 404));
      const [, id, action] = match;
      const route = request.method === 'DELETE' && !action ? '/delete'
        : !action && request.method === 'GET' ? '/status'
        : action === 'source' && request.method === 'POST' ? '/upload-source'
        : action && ((request.method === 'GET' && ['source', 'working', 'pdf', 'candidate'].includes(action)) || (request.method === 'POST' && ['start', 'email', 'cancel', 'approve'].includes(action))) ? `/${action}` : null;
      if (!route) return finish(json({ error: 'Method not allowed.' }, 405));
      const forwarded = new Request(`https://run${route}`, request); forwarded.headers.set('X-Studio-Owner', principalId);
      const result = await runStub(id).fetch(forwarded);
      if (route === '/delete' && (result.ok || result.status === 404)) await catalog.fetch(new Request(`https://catalog/${id}`, { method: 'DELETE', headers: trusted }));
      return finish(result);
    } catch (error) { return finish(json({ error: error instanceof Error ? error.message : 'Request failed.' }, 400)); }
  },
} satisfies ExportedHandler<RunnerEnv>;
