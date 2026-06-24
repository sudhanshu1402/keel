import { describe, it, expect } from 'vitest';
import { createTestKeel, defineWorkflow } from '../src/index.js';

describe('createTestKeel', () => {
  it('runs a workflow with zero infra and counts model calls', async () => {
    const t = createTestKeel({ respond: () => 'summary' });
    const wf = defineWorkflow<{ topic: string }, string>('research', async (ctx, input) => {
      const fetched = await ctx.step('fetch', () => `data about ${input.topic}`);
      const summary = await ctx.llm('summarize', { prompt: fetched });
      return summary.text;
    });
    const r = await t.keel.run(wf, { topic: 'durability' });
    expect(r.status).toBe('completed');
    expect(r.output).toBe('summary');
    expect(t.provider.calls).toBe(1);
  });

  it('uses deterministic run ids and a controllable clock', async () => {
    const t = createTestKeel({ startTime: 1000 });
    expect(t.now()).toBe(1000);
    const wf = defineWorkflow('noop', async (ctx) => ctx.step('s', () => 1));
    const r1 = await t.keel.run(wf, {});
    const r2 = await t.keel.run(wf, {});
    expect(r1.runId).toBe('test_run_1');
    expect(r2.runId).toBe('test_run_2');
    t.advance(500);
    expect(t.now()).toBe(1500);
  });

  it('drives durable timers with the supervisor and the test clock', async () => {
    const t = createTestKeel({ durableTimers: true });
    const wf = defineWorkflow('napper', async (ctx) => {
      await ctx.sleep('wait', 5000);
      return ctx.step('after', () => 'awake');
    });
    const r = await t.keel.run(wf, {});
    expect(r.status).toBe('paused');

    // Not yet due.
    t.advance(1000);
    const ready1 = await t.store.getReadySteps(t.now());
    expect(ready1.length).toBe(0);

    // Past the wake time: the step is ready and resume completes it.
    t.advance(5000);
    const ready2 = await t.store.getReadySteps(t.now());
    expect(ready2.map((s) => s.runId)).toContain(r.runId);
    const resumed = await t.keel.resume(r.runId);
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('awake');
  });
});
