export const ENGINE_ORIGIN = 'https://api-production-f0b01d62.up.railway.app';
export const STUDIO_ORIGINS = ['https://fp0et9oqqbr0kamofkwoe-web-agentic-pdf.rork.live', 'https://agentic-pdf-edit.rork.app'];
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PAGES = 50;
export const MAX_OPERATIONS = 120;
export interface Operation {
  id: string; kind?: 'text' | 'clone_page' | 'delete_page' | 'rotate_page'; page: number;
  find: string; replace: string; plainSummary: string; rotateDegrees?: number;
  bbox?: [number, number, number, number];
}
export function validateOperations(input: unknown, pages: number): Operation[] {
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) throw new Error('Cloud editing supports 1–50 pages.');
  if (!Array.isArray(input) || !input.length || input.length > MAX_OPERATIONS) throw new Error('Approve between 1 and 120 edits per round.');
  const structural = new Set<number>(); const ids = new Set<string>(); const textTargets = new Map<number, string[]>();
  let deleted = 0;
  const result = input.map((raw: unknown, index): Operation => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid edit.');
    const o = raw as Record<string, unknown>;
    const kind = o.kind ?? 'text';
    if (!['text', 'clone_page', 'delete_page', 'rotate_page'].includes(String(kind))) throw new Error('Unsupported edit type.');
    if (typeof o.page !== 'number' || !Number.isInteger(o.page) || o.page < 1 || o.page > pages) throw new Error('An edit targets an invalid page.');
    const id = typeof o.id === 'string' ? o.id : `op-${index + 1}`;
    if (ids.has(id)) throw new Error('Duplicate edit identifier.'); ids.add(id);
    if (typeof o.find !== 'string' || typeof o.replace !== 'string' || o.find.length > 2000 || o.replace.length > 2000) throw new Error('Every edit needs explicit, bounded original and replacement text.');
    if (kind === 'text') {
      if (!o.find.trim() || o.find === o.replace) throw new Error('An edit has no meaningful change.');
      // The engine uses a plain-language rule parser. Never strip or reinterpret delimiters.
      if (/[";\r\n]/.test(o.find + o.replace) || /\s+(to|with)\s+/i.test(o.find)) throw new Error('This text cannot be addressed safely by the editing engine. Use a shorter exact text cell.');
      const previous = textTargets.get(o.page) ?? [];
      if (previous.some(t => t.includes(String(o.find)) || String(o.find).includes(t))) throw new Error('Overlapping text edits need to be combined before approval.');
      previous.push(o.find); textTargets.set(o.page, previous);
    } else {
      if (structural.has(o.page)) throw new Error('Use one page action per original page in each round.');
      structural.add(o.page);
      if (kind === 'delete_page') deleted++;
      if (kind === 'rotate_page' && ![90, 180, 270].includes(Number(o.rotateDegrees))) throw new Error('Rotation must be 90, 180 or 270 degrees.');
    }
    return { id, kind: kind as Operation['kind'], page: o.page, find: o.find, replace: o.replace,
      plainSummary: typeof o.plainSummary === 'string' ? o.plainSummary.slice(0, 500) : `Update page ${o.page}`,
      ...(kind === 'rotate_page' ? { rotateDegrees: Number(o.rotateDegrees) } : {}) };
  });
  const textEdits = result.filter(o => o.kind === 'text');
  if (textEdits.some((a, i) => textEdits.some((b, j) => i !== j && a.page === b.page && a.replace.toLowerCase().includes(b.find.toLowerCase())))) throw new Error('A replacement introduces another edit target on the same page. Combine these changes before approval.');
  if (deleted >= pages) throw new Error('A document must retain at least one original page.');
  if (result.some(o => o.kind === 'delete_page' && textTargets.has(o.page))) throw new Error('Do not edit text on a page selected for deletion.');
  if (pages - deleted + result.filter(o => o.kind === 'clone_page').length > MAX_PAGES) throw new Error('The result exceeds 50 pages.');
  return result;
}
export function safeEngineUrl(value: string): string {
  const url = new URL(value, `${ENGINE_ORIGIN}/`);
  if (url.origin !== ENGINE_ORIGIN || url.username || url.password || !url.pathname.startsWith('/api/')) throw new Error('The engine returned an unapproved document address.');
  return url.href;
}
export function safeReturnUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A studio return address is required.');
  const url = new URL(value);
  if (!STUDIO_ORIGINS.includes(url.origin) || url.username || url.password) throw new Error('Unapproved studio return address.');
  return url.origin + '/';
}
export function validEmail(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new Error('Please enter a valid email, or leave it empty to remove notifications.');
  return value.trim();
}
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) throw new Error('Missing request body.');
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('Document or request exceeds its size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function readJson(request: Request, limit = 512_000): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(new TextDecoder().decode(await readLimited(request.body, limit)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a request object.');
  return value as Record<string, unknown>;
}
