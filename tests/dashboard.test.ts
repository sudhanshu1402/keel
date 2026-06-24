import { describe, it, expect, afterEach } from 'vitest';
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
});
