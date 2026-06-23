import { describe, it, expect } from 'vitest';
import {
  Keel,
  MemoryStore,
  MockProvider,
  OllamaProvider,
  defineWorkflow,
} from '../src/index.js';

const instant = async (): Promise<void> => {};

describe('llm step', () => {
  it('captures tokens and memoizes the provider call on replay', async () => {
    const provider = new MockProvider(() => 'hello world');
    const wf = defineWorkflow('llm', async (ctx) => {
      const out = await ctx.llm('ask', { prompt: 'say hi please' });
      return out.text;
    });

    const store = new MemoryStore();
    const keel = new Keel({ store, provider, sleepFn: instant });

    const r1 = await keel.run(wf, {});
    expect(r1.output).toBe('hello world');
    expect(provider.calls).toBe(1);

    const step = (await store.listSteps(r1.runId)).find((s) => s.name === 'ask');
    expect(step?.tokensIn).toBe(3);
    expect(step?.tokensOut).toBe(2);

    const r2 = await keel.resume(r1.runId);
    expect(r2.output).toBe('hello world');
    expect(provider.calls).toBe(1); // memoized; provider not called again
  });

  it('throws when an llm step runs without a configured provider', async () => {
    const wf = defineWorkflow('no-provider', async (ctx) => {
      const out = await ctx.llm('ask', { prompt: 'hi' });
      return out.text;
    });
    const keel = new Keel({ sleepFn: instant });
    const r = await keel.run(wf, {});
    expect(r.status).toBe('failed');
    expect(r.error).toContain('no LLM provider configured');
  });
});

describe('OllamaProvider', () => {
  it('builds the generate request with model, prompt, and no streaming', () => {
    const p = new OllamaProvider({
      host: 'http://localhost:11434',
      model: 'llama3.2',
    });
    const { url, body } = p.buildRequest({ prompt: 'hi' });
    expect(url).toBe('http://localhost:11434/api/generate');
    expect(body.model).toBe('llama3.2');
    expect(body.prompt).toBe('hi');
    expect(body.stream).toBe(false);
  });

  it('parses a completion from an injected fetch (no network)', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        response: 'pong',
        prompt_eval_count: 3,
        eval_count: 1,
      }),
    })) as unknown as typeof fetch;
    const p = new OllamaProvider({ fetchImpl: fakeFetch });
    const res = await p.complete({ prompt: 'ping' });
    expect(res.text).toBe('pong');
    expect(res.tokensIn).toBe(3);
    expect(res.tokensOut).toBe(1);
  });

  it('throws on a non-ok response', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const p = new OllamaProvider({ fetchImpl: fakeFetch });
    await expect(p.complete({ prompt: 'x' })).rejects.toThrow('status 500');
  });
});
