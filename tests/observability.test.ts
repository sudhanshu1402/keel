import { describe, it, expect } from 'vitest';
import {
  Keel,
  MemoryStore,
  MockProvider,
  defineWorkflow,
  type KeelEvent,
} from '../src/index.js';

const instant = async (): Promise<void> => {};

describe('onEvent observability hook', () => {
  it('emits start then complete for a durable step', async () => {
    const events: KeelEvent[] = [];
    const keel = new Keel({ sleepFn: instant, onEvent: (e) => events.push(e) });
    const wf = defineWorkflow('obs', async (ctx) => ctx.step('s', () => 1));
    await keel.run(wf, {});

    const forS = events.filter((e) => e.step === 's');
    expect(forS.map((e) => e.type)).toEqual(['step:start', 'step:complete']);
    expect(forS.every((e) => e.kind === 'step')).toBe(true);
    const done = forS.find((e) => e.type === 'step:complete');
    expect(done?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('tags llm steps with kind "llm"', async () => {
    const events: KeelEvent[] = [];
    const provider = new MockProvider(() => 'hi');
    const keel = new Keel({
      provider,
      sleepFn: instant,
      onEvent: (e) => events.push(e),
    });
    const wf = defineWorkflow('obs-llm', async (ctx) => {
      const out = await ctx.llm('ask', { prompt: 'hello there' });
      return out.text;
    });
    await keel.run(wf, {});

    const forAsk = events.filter((e) => e.step === 'ask');
    expect(forAsk.length).toBe(2);
    expect(forAsk.every((e) => e.kind === 'llm')).toBe(true);
    expect(forAsk.map((e) => e.type)).toEqual(['step:start', 'step:complete']);
  });

  it('emits a fail event with the error message when a step exhausts retries', async () => {
    const events: KeelEvent[] = [];
    const keel = new Keel({ sleepFn: instant, onEvent: (e) => events.push(e) });
    const wf = defineWorkflow('obs-fail', async (ctx) =>
      ctx.step(
        'boom',
        () => {
          throw new Error('nope');
        },
        { retry: { maxAttempts: 1 } },
      ),
    );
    const r = await keel.run(wf, {});
    expect(r.status).toBe('failed');

    const fail = events.find((e) => e.type === 'step:fail');
    expect(fail?.step).toBe('boom');
    expect(fail?.error).toContain('nope');
  });

  it('never lets a throwing callback break the run', async () => {
    const keel = new Keel({
      sleepFn: instant,
      onEvent: () => {
        throw new Error('listener exploded');
      },
    });
    const wf = defineWorkflow<unknown, number>('obs-safe', async (ctx) =>
      ctx.step('s', () => 42),
    );
    const r = await keel.run(wf, {});
    expect(r.status).toBe('completed');
    expect(r.output).toBe(42);
  });
});
