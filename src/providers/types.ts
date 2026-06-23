export interface CompleteArgs {
  prompt: string;
  model?: string;
}

export interface CompleteResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
}

/** LLM access boundary. Ollama is the zero-cost default; Mock is for tests. */
export interface Provider {
  complete(args: CompleteArgs): Promise<CompleteResult>;
}
