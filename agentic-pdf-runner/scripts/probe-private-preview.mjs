// Non-owner probes only. Never supplies a real token, document or stored run ID.
const base = 'https://fp0et9oqqbr0kamofkwoe-agentic-pdf-runner.rork.live';
const id = `probe-${crypto.randomUUID().slice(0, 24)}`;
const results = [];
async function probe(method, path, spoof = false) {
  const response = await fetch(base + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Origin: 'https://untrusted.example.test', ...(spoof ? { 'X-Rork-User-Id': 'synthetic-spoof', 'X-Studio-Owner': 'synthetic-spoof' } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  const body = await response.json();
  if (response.status !== 401 || response.headers.get('Access-Control-Allow-Origin')) throw new Error(`${method} ${path} did not reject untrusted access (${response.status}).`);
  if (typeof body.error !== 'string' || Object.keys(body).length !== 1) throw new Error('The denial response exposed unexpected data.');
  results.push({ method, path: path.replace(id, '<synthetic-id>'), spoof, status: response.status });
}
for (const spoof of [false, true]) {
  for (const [method, path] of [
    ['GET', '/runs'], ['POST', '/runs'], ['POST', '/plan'],
    ['GET', `/runs/${id}`], ['GET', `/runs/${id}/source`], ['GET', `/runs/${id}/working`], ['GET', `/runs/${id}/pdf`], ['GET', `/runs/${id}/candidate`], ['POST', `/runs/${id}/approve`],
    ['POST', `/runs/${id}/source`], ['POST', `/runs/${id}/start`], ['POST', `/runs/${id}/email`], ['POST', `/runs/${id}/cancel`], ['DELETE', `/runs/${id}`],
  ]) await probe(method, path, spoof);
}
const access = await fetch(base + '/access', { headers: { 'X-Rork-User-Id': 'synthetic-spoof' }, signal: AbortSignal.timeout(20000) }).then(r => r.json());
if (access.userId !== null || access.allowed !== false) throw new Error('The perimeter accepted a forged identity.');
console.log(JSON.stringify({ scope: 'preview-only signed-out and spoofed-header probes; no real identities or documents', passed: results.length + 1, results, access }, null, 2));
