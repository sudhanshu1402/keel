import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { createTestKeel, defineWorkflow, startDashboard } from '../src/index.js';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function get(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(
  port: number,
  path: string,
  data: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}

describe('dashboard', () => {
  it('serves the run list and run detail as JSON', async () => {
    const t = createTestKeel();
    const wf = defineWorkflow('w', async (ctx) => {
      await ctx.step('one', () => 1);
      return ctx.step('two', () => 2);
    });
    const r = await t.keel.run(wf, {});

    const started = await startDashboard({ store: t.store, keel: t.keel, port: 0 });
    server = started.server;
    const port = started.port;

    const list = await get(port, '/api/runs');
    expect(list.status).toBe(200);
    expect(list.body.engine).toBe(true);
    expect(list.body.runs.map((x: any) => x.id)).toContain(r.runId);

    const detail = await get(port, `/api/runs/${r.runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.run.status).toBe('completed');
    expect(detail.body.steps.map((s: any) => s.name)).toEqual(['one', 'two']);

    const missing = await get(port, '/api/runs/nope');
    expect(missing.status).toBe(404);
  });

  it('delivers a signal through the attached engine and resumes the run', async () => {
    const t = createTestKeel();
    const wf = defineWorkflow<unknown, string>('approval', async (ctx) => {
      const decision = await ctx.waitForSignal<string>('approve');
      return ctx.step('act', () => `did ${decision}`);
    });
    const r = await t.keel.run(wf, {});
    expect(r.status).toBe('paused');

    const started = await startDashboard({ store: t.store, keel: t.keel, port: 0 });
    server = started.server;
    const port = started.port;

    const sig = await post(port, `/api/runs/${r.runId}/signal`, {
      name: 'approve',
      value: 'ship-it',
    });
    expect(sig.status).toBe(200);
    expect(sig.body.delivered).toBe(true);

    const detail = await get(port, `/api/runs/${r.runId}`);
    expect(detail.body.run.status).toBe('completed');
    expect(detail.body.run.output).toBe('did ship-it');
  });

  it('is read-only when no engine is attached', async () => {
    const t = createTestKeel();
    const wf = defineWorkflow('w', async (ctx) => ctx.step('one', () => 1));
    const r = await t.keel.run(wf, {});

    const started = await startDashboard({ store: t.store, port: 0 });
    server = started.server;
    const port = started.port;

    const list = await get(port, '/api/runs');
    expect(list.body.engine).toBe(false);

    const resume = await post(port, `/api/runs/${r.runId}/resume`, {});
    expect(resume.status).toBe(400);

    const sig = await post(port, `/api/runs/${r.runId}/signal`, { name: 'x', value: 1 });
    expect(sig.status).toBe(200);
    expect(sig.body.stored).toBe(true);
    expect((await t.store.getSignal(r.runId, 'x'))?.value).toBe(1);
  });
  // CWE-209. startDashboard accepts allowRemote:true, so a 500 body can reach the
  // network, and keel.resume throws messages that carry the run id and, for a
  // failure inside workflow code, whatever that code threw. OWASP's guidance is a
  // generic body to the caller and the detail in the log; both halves are asserted
  // here, because dropping the detail entirely would be the other way to fail.
  it('keeps internal error detail out of the response and puts it in the log', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });

    try {
      const t = createTestKeel();
      const started = await startDashboard({ store: t.store, keel: t.keel, port: 0 });
      server = started.server;

      const res = await post(started.port, '/api/runs/secret-run-id/resume', {});

      expect(res.status).toBe(500);
      expect(res.body.ref).toMatch(/^[0-9a-f]{8}$/);
      // The underlying throw is `run secret-run-id not found`.
      expect(JSON.stringify(res.body)).not.toContain('secret-run-id');
      expect(JSON.stringify(res.body)).not.toContain('not found');

      const line = logged.find((l) => l.includes(res.body.ref));
      expect(line, 'the ref must appear in the log so it can be correlated').toBeTruthy();
      expect(line).toContain('secret-run-id');
      expect(line).toContain('not found');
    } finally {
      spy.mockRestore();
    }
  });

  it('uses a fresh ref per failure, so two reports cannot be confused', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const t = createTestKeel();
      const started = await startDashboard({ store: t.store, keel: t.keel, port: 0 });
      server = started.server;

      const a = await post(started.port, '/api/runs/a/resume', {});
      const b = await post(started.port, '/api/runs/b/resume', {});

      expect(a.body.ref).not.toBe(b.body.ref);
    } finally {
      spy.mockRestore();
    }
  });
});
