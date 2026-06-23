/**
 * A two-step LLM research agent that is durable and crash-proof.
 *
 * Each model call is a recorded step: if the process dies between calls, a
 * resume replays the first answer from disk instead of paying for it again.
 * Uses Ollama by default (free, local, no API key). Start Ollama first:
 *
 *   ollama serve
 *   ollama pull llama3.2
 *   npx tsx examples/agent-research.ts "durable execution"
 *
 * No Ollama installed? Pass --mock to run against a built-in fake provider:
 *
 *   npx tsx examples/agent-research.ts "durable execution" --mock
 */
import {
  Keel,
  FileStore,
  OllamaProvider,
  MockProvider,
  defineWorkflow,
  type Provider,
} from '../src/index.js';

const args = process.argv.slice(2);
const useMock = args.includes('--mock');
const topic = args.find((a) => !a.startsWith('--')) ?? 'durable execution';

const provider: Provider = useMock
  ? new MockProvider((a) =>
      a.prompt.startsWith('List')
        ? '1. What problem does it solve? 2. How does it work? 3. When to use it?'
        : `A concise explanation about "${topic}".`,
    )
  : new OllamaProvider();

const research = defineWorkflow<{ topic: string }, { summary: string }>(
  'research-agent',
  async (ctx, input) => {
    const questions = await ctx.llm('plan-questions', {
      prompt: `List three sharp research questions about: ${input.topic}`,
    });
    console.log('\nQuestions:\n' + questions.text);

    const summary = await ctx.llm('write-summary', {
      prompt: `Using these questions, write a short briefing on ${input.topic}:\n${questions.text}`,
    });
    console.log('\nSummary:\n' + summary.text);

    const totalIn = questions.tokensIn + summary.tokensIn;
    const totalOut = questions.tokensOut + summary.tokensOut;
    console.log(`\nTokens: ${totalIn} in / ${totalOut} out`);

    return { summary: summary.text };
  },
);

const keel = new Keel({
  store: new FileStore('keel-data/research.json'),
  provider,
});

async function main(): Promise<void> {
  console.log(`Researching: ${topic}${useMock ? ' (mock provider)' : ''}`);
  const result = await keel.run(research, { topic });
  console.log(`\nRun ${result.runId} ended as: ${result.status}`);
}

main().catch((err) => {
  console.error(
    '\nFailed. If you are not running Ollama, retry with --mock.\n',
    err,
  );
  process.exit(1);
});
