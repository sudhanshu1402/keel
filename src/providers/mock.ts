import type { CompleteArgs, CompleteResult, Provider } from './types.js';

const countTokens = (text: string): number =>
  text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

/** Deterministic provider for tests. Records how many times it was called. */
export class MockProvider implements Provider {
  public calls = 0;

  constructor(
    private readonly responder: (args: CompleteArgs) => string = () =>
      'mock response',
  ) {}

  async complete(args: CompleteArgs): Promise<CompleteResult> {
    this.calls++;
    const text = this.responder(args);
    return {
      text,
      tokensIn: countTokens(args.prompt),
      tokensOut: countTokens(text),
    };
  }
}
