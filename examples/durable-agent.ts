/**
 * A durable tool-using agent that survives a crash in the middle of its loop.
 *
 * The agent runs a multi-turn loop: each model call and each tool call is a
 * recorded step. We force the second tool call to throw the first time (as if
 * the process died mid-tool-call), then resume. On resume, keel replays the
 * earlier turns from disk: the model is NOT called again for them, and the
 * already-finished tool is not re-run. Only the failed tool and the turns after
 * it execute.
 *
 *   npx tsx examples/durable-agent.ts
 *
 * Uses the built-in MockProvider so it runs with zero setup, no API key, no
 * network. To use a real model, swap in the OpenAI or Anthropic adapter from
 * examples/providers/ -- the durability behavior is identical.
 */
import { Keel, FileStore, MockProvider } from '../src/index.js';
import { defineAgent, type AgentTool } from '../src/agent.js';

// Scripted "model": one JSON action per turn, in order.
const script = [
  JSON.stringify({ tool: 'search', args: { q: 'durable execution' } }),
  JSON.stringify({ tool: 'fetch', args: { id: 42 } }),
  JSON.stringify({ final: 'Durable execution replays finished steps from a log.' }),
];
let turn = 0;
const provider = new MockProvider(() => script[turn++] ?? '{"final":"done"}');

let crash = true;
let fetchAttempts = 0;
const tools: AgentTool[] = [
  {
    name: 'search',
    description: 'search the web, returns result ids',
    run: ({ q }) => {
      console.log(`  [tool] search(${JSON.stringify(q)})`);
      return [41, 42, 43];
    },
  },
  {
    name: 'fetch',
    description: 'fetch a record by id',
    run: ({ id }) => {
      fetchAttempts += 1;
      console.log(`  [tool] fetch(${id}) attempt ${fetchAttempts}`);
      if (crash) throw new Error('simulated crash mid-tool-call');
      return { id, title: 'What is durable execution?' };
    },
  },
];

const agent = defineAgent('durable-agent', { tools });
const keel = new Keel({
  store: new FileStore('keel-data/durable-agent.json'),
  provider,
  // Keep the demo fast: no backoff between the failing tool's retries.
  sleepFn: async () => {},
});

async function main(): Promise<void> {
  console.log('First pass (the process will "crash" mid-loop):');
  const r1 = await keel.run(agent, { prompt: 'Explain durable execution.' });
  console.log(`  run ${r1.runId} ended as: ${r1.status}`);
  console.log(`  model calls so far: ${provider.calls}\n`);

  console.log('Recovering: resuming the same run after the crash is fixed.');
  crash = false;
  const r2 = await keel.resume(r1.runId);
  console.log(`  run ${r2.runId} ended as: ${r2.status}`);
  console.log(`  answer: ${(r2.output as { answer: string }).answer}`);
  console.log(`  total model calls: ${provider.calls} (turns 1-2 replayed, not re-called)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
