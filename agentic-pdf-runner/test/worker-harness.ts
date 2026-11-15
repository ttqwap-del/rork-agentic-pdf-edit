// Local Miniflare entry only. Never imported by the deployed worker.
// Synthetic tests control alarms and inspect isolated SQLite state; no live storage is used.
import app from '../index';
import { RunCoordinator as ProductionRunCoordinator, StudioCatalog, type RunnerEnv } from '../run-coordinator';

export { StudioCatalog };
export class RunCoordinator extends ProductionRunCoordinator {
  private holdNextApproval = false;
  private heldBody: ReadableStreamDefaultController<Uint8Array> | null = null;
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/__test/hold') { this.holdNextApproval = true; return Response.json({ ok: true }); }
    if (path === '/__test/paused') return Response.json({ paused: Boolean(this.heldBody) });
    if (path === '/__test/release') { this.heldBody?.close(); this.heldBody = null; return Response.json({ ok: true }); }
    if (path === '/approve' && this.holdNextApproval) {
      this.holdNextApproval = false;
      const bytes = new Uint8Array(await request.arrayBuffer());
      const body = new ReadableStream<Uint8Array>({ start: controller => { this.heldBody = controller; controller.enqueue(bytes); } });
      return super.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body }));
    }
    if (path === '/__test/drop-alarm') {
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true });
    }
    if (path === '/__test/tick') {
      await this.ctx.storage.deleteAlarm();
      await this.alarm();
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true });
    }
    if (path === '/__test/storage') {
      const row = this.ctx.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM run_meta WHERE id=1').toArray()[0];
      return Response.json({ state: row ? JSON.parse(row.state_json) : null, chunks: this.ctx.storage.sql.exec('SELECT slot,COUNT(*) AS n FROM pdf_chunks GROUP BY slot').toArray(), notifications: this.ctx.storage.sql.exec('SELECT * FROM notification').toArray() });
    }
    if (path === '/__test/legacy') {
      const row = this.ctx.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM run_meta WHERE id=1').toArray()[0];
      const state = JSON.parse(row.state_json); delete state.requiresCandidateApproval;
      this.ctx.storage.sql.exec('UPDATE run_meta SET state_json=? WHERE id=1', JSON.stringify(state));
      return Response.json({ ok: true });
    }
    if (path === '/__test/tamper') {
      this.ctx.storage.sql.exec('UPDATE pdf_chunks SET chunk=? WHERE slot=? AND idx=0', new Uint8Array([1, 2, 3]), 'candidate');
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: RunnerEnv) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/__test\/(tick|drop-alarm|storage|legacy|tamper|hold|paused|release)\/([a-z0-9]+)$/);
    if (match) return env.RUN_COORDINATOR.get(env.RUN_COORDINATOR.idFromName(match[2])).fetch(new Request(`https://run/__test/${match[1]}`, request));
    return app.fetch(request, env);
  },
};
