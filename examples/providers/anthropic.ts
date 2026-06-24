/**
 * Example Anthropic Provider adapter. Lives in examples/, not core: keel core
 * has zero runtime dependencies, and this adapter has none either (it uses the
 * built-in global `fetch`). Copy it into your app and import keel's `Provider`
 * type. Set ANTHROPIC_API_KEY or pass `apiKey`.
 *
 *   const provider = new AnthropicProvider({ model: 'claude-3-5-haiku-latest' });
 *   const keel = new Keel({ store, provider });
 */
import type { CompleteArgs, CompleteResult, Provider } from '../../src/index.js';

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

interface MessagesResponse {
  content: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements Provider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.model = opts.model ?? 'claude-3-5-haiku-latest';
    this.baseUrl = opts.baseUrl ?? 'https://api.anthropic.com/v1';
    this.maxTokens = opts.maxTokens ?? 1024;
    if (!this.apiKey) {
      throw new Error('AnthropicProvider: set ANTHROPIC_API_KEY or pass { apiKey }');
    }
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: args.model ?? this.model,
        max_tokens: this.maxTokens,
        messages: [{ role: 'user', content: args.prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as MessagesResponse;
    const text = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      text,
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
    };
  }
}
