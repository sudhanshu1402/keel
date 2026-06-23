import type { CompleteArgs, CompleteResult, Provider } from './types.js';

export interface OllamaOptions {
  host?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateBody {
  model: string;
  prompt: string;
  stream: false;
}

interface OllamaGenerateResponse {
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Free, local LLM provider backed by Ollama (https://ollama.com). No API key,
 * no account, no cost. Defaults to http://localhost:11434 and can be pointed
 * elsewhere via options or the OLLAMA_HOST / OLLAMA_MODEL env vars.
 */
export class OllamaProvider implements Provider {
  private readonly host: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaOptions = {}) {
    this.host = opts.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    this.defaultModel =
      opts.model ?? process.env.OLLAMA_MODEL ?? 'llama3.2';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Pure request builder, separated so it can be unit-tested with no network. */
  buildRequest(args: CompleteArgs): { url: string; body: OllamaGenerateBody } {
    return {
      url: `${this.host}/api/generate`,
      body: {
        model: args.model ?? this.defaultModel,
        prompt: args.prompt,
        stream: false,
      },
    };
  }

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    const { url, body } = this.buildRequest(args);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ollama request failed with status ${res.status}`);
    }
    const data = (await res.json()) as OllamaGenerateResponse;
    return {
      text: data.response ?? '',
      tokensIn: data.prompt_eval_count ?? 0,
      tokensOut: data.eval_count ?? 0,
    };
  }
}
