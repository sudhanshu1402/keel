import { describe, it, expect } from 'vitest';
import { createTestKeel } from '../src/index.js';
import { defineAgent, type AgentTool } from '../src/agent.js';

describe('DurableAgent', () => {
  it('runs a tool then returns a final answer, memoizing each model call', async () => {
    const script = [
      JSON.stringify({ tool: 'add', args: { a: 2, b: 3 } }),
      JSON.stringify({ final: 'the sum is 5' }),
    ];
    let i = 0;
    const t = createTestKeel({ respond: () => script[i++] ?? '{"final":"?"}' });

    const tools: AgentTool[] = [
      { name: 'add', description: 'add two numbers', run: ({ a, b }) => a + b },
    ];
    const agent = defineAgent('calc', { tools });

    const r = await t.keel.run(agent, { prompt: 'what is 2+3?' });
    expect(r.status).toBe('completed');
    const out = r.output as { answer: string; turns: number; toolCalls: unknown[] };
    expect(out.answer).toBe('the sum is 5');
    expect(out.turns).toBe(2);
    expect(out.toolCalls).toEqual([{ tool: 'add', args: { a: 2, b: 3 }, result: 5 }]);
    expect(t.provider.calls).toBe(2);
  });

  it('never coerces a non-JSON reply into a final answer', async () => {
    // A model that never emits valid protocol JSON must not be mistaken for one
    // that produced a final answer. The loop feeds the parse error back, burns
    // its turns, and stops with stopReason 'max_turns' -- not 'final'.
    const t = createTestKeel({ respond: () => 'I think the answer is 42.' });
    const agent = defineAgent('plain', { maxTurns: 3 });
    const r = await t.keel.run(agent, { prompt: 'hi' });
    const out = r.output as {
      answer: string;
      turns: number;
      stopReason: string;
      toolCalls: { tool: string }[];
    };
    expect(out.stopReason).toBe('max_turns');
    expect(out.turns).toBe(3);
    expect(out.answer).not.toBe('I think the answer is 42.');
    expect(out.toolCalls.every((c) => c.tool === '(invalid)')).toBe(true);
  });

  it('stops with stopReason "final" only when the model emits a final', async () => {
    const t = createTestKeel({ respond: () => JSON.stringify({ final: 'done' }) });
    const agent = defineAgent('finisher', {});
    const r = await t.keel.run(agent, { prompt: 'hi' });
    const out = r.output as { answer: string; stopReason: string; turns: number };
    expect(out.stopReason).toBe('final');
    expect(out.answer).toBe('done');
    expect(out.turns).toBe(1);
  });

  it('stops at the token budget with stopReason "budget"', async () => {
    // MockProvider reports tokens per call; a low maxTokens trips on turn 1.
    const t = createTestKeel({ respond: () => JSON.stringify({ tool: 'noop', args: {} }) });
    const tools: AgentTool[] = [
      { name: 'noop', description: 'does nothing', run: () => 'ok' },
    ];
    const agent = defineAgent('budgeted', { tools, maxTokens: 1, maxTurns: 10 });
    const r = await t.keel.run(agent, { prompt: 'go' });
    const out = r.output as { stopReason: string; turns: number };
    expect(out.stopReason).toBe('budget');
    expect(out.turns).toBe(1);
  });

  it('rejects a tool call whose args fail validation, without running the tool', async () => {
    const script = [
      JSON.stringify({ tool: 'div', args: { n: 'oops' } }), // invalid
      JSON.stringify({ final: 'gave up' }),
    ];
    let i = 0;
    const t = createTestKeel({ respond: () => script[i++] ?? '{"final":"?"}' });
    let ran = 0;
    const tools: AgentTool[] = [
      {
        name: 'div',
        description: 'reciprocal',
        validateArgs: (a) =>
          typeof (a as { n?: unknown }).n === 'number' ? undefined : 'n must be a number',
        run: ({ n }) => {
          ran += 1;
          return 1 / n;
        },
      },
    ];
    const agent = defineAgent('guarded', { tools });
    const r = await t.keel.run(agent, { prompt: 'divide' });
    const out = r.output as { toolCalls: { tool: string; result: unknown }[] };
    expect(ran).toBe(0);
    expect(out.toolCalls[0]!.result).toEqual({ error: 'invalid args: n must be a number' });
  });

  it('extracts the first balanced JSON object from prose, not a greedy first-to-last-brace span', async () => {
    // A reply with a valid action embedded in prose, followed by more text that
    // contains another brace. A greedy "first { to last }" slice would capture
    // an invalid span and lose the action; the balanced scanner takes the first
    // complete object and ignores the trailing noise.
    const t = createTestKeel({
      respond: () => 'Sure, here goes: {"final": "first answer"} -- also see {notes}.',
    });
    const agent = defineAgent('prose', { maxTurns: 2 });
    const r = await t.keel.run(agent, { prompt: 'hi' });
    const out = r.output as { answer: string; stopReason: string; turns: number };
    expect(out.stopReason).toBe('final');
    expect(out.answer).toBe('first answer');
    expect(out.turns).toBe(1);
  });

  it('resumes mid-loop after a crash without re-calling the model for prior turns', async () => {
    const script = [
      JSON.stringify({ tool: 'search', args: { q: 'keel' } }), // turn 1
      JSON.stringify({ tool: 'load', args: { id: 7 } }), // turn 2 (tool crashes)
      JSON.stringify({ final: 'loaded record 7' }), // turn 3 (only after resume)
    ];
    let i = 0;
    const t = createTestKeel({ respond: () => script[i++] ?? '{"final":"?"}' });

    let crash = true;
    let loadCalls = 0;
    const tools: AgentTool[] = [
      { name: 'search', description: 'search the web', run: () => ['a', 'b'] },
      {
        name: 'load',
        description: 'load a record by id',
        run: () => {
          loadCalls += 1;
          if (crash) throw new Error('disk gone');
          return { id: 7, ok: true };
        },
      },
    ];
    const agent = defineAgent('researcher', { tools });

    const r1 = await t.keel.run(agent, { prompt: 'research keel' });
    expect(r1.status).toBe('failed');
    // turn-1 and turn-2 model calls happened before the tool crashed.
    expect(t.provider.calls).toBe(2);

    crash = false;
    const r2 = await t.keel.resume(r1.runId);
    expect(r2.status).toBe('completed');
    expect((r2.output as { answer: string }).answer).toBe('loaded record 7');
    // Only turn-3 was a new model call; turns 1 and 2 replayed from the store.
    expect(t.provider.calls).toBe(3);
    // 'load' ran its (failing) attempts on the first pass, then succeeded once on resume.
    expect(loadCalls).toBeGreaterThanOrEqual(2);
  });
});
