/**
 * Example OpenAI Provider adapter. Lives in examples/, not core: keel core has
 * zero runtime dependencies, and this adapter has none either (it uses the
 * built-in global `fetch`). Copy it into your app and import keel's `Provider`
 * type. Set OPENAI_API_KEY or pass `apiKey`.
 *
 *   const provider = new OpenAIProvider({ model: 'gpt-4o-mini' });
 *   const keel = new Keel({ store, provider });
 */
import type { CompleteArgs, CompleteResult, Provider } from '../../src/index.js';

export interface OpenAIOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface ChatResponse {
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export class OpenAIProvider implements Provider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAIOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = opts.model ?? 'gpt-4o-mini';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    if (!this.apiKey) {
      throw new Error('OpenAIProvider: set OPENAI_API_KEY or pass { apiKey }');
    }
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: args.model ?? this.model,
        messages: [{ role: 'user', content: args.prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as ChatResponse;
    return {
      text: data.choices[0]?.message.content ?? '',
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  }
}
