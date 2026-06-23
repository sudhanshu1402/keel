import type { RetryPolicy } from './retry.js';

export interface StepOptions {
  retry?: Partial<RetryPolicy>;
}

export interface LlmArgs {
  prompt: string;
  model?: string;
}

export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
}

/**
 * The handle a workflow uses to record durable steps. Any work whose result
 * must survive a restart, or that has side effects or nondeterminism, must go
 * through one of these methods.
 */
export interface WorkflowContext {
  readonly runId: string;
  /** Run fn once, persist its result, and replay that result on later runs. */
  step<T>(name: string, fn: () => Promise<T> | T, opts?: StepOptions): Promise<T>;
  /** Durable delay. Survives restarts; replays instantly once elapsed. */
  sleep(name: string, ms: number): Promise<void>;
  /** A step backed by the configured LLM provider, with token capture. */
  llm(name: string, args: LlmArgs): Promise<LlmResult>;
}
