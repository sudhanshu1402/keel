export interface RetryPolicy {
  /** Total attempts including the first. 1 means no retry. */
  maxAttempts: number;
  /** Delay before the second attempt, in milliseconds. */
  baseMs: number;
  /** Multiplier applied to the delay per attempt. */
  factor: number;
  /** When true, multiply the delay by a random factor in [0.5, 1.0). */
  jitter: boolean;
  /** Return false to stop retrying a given error. Defaults to always retry. */
  retryable?: (err: unknown) => boolean;
}

export const defaultStepRetry: RetryPolicy = {
  maxAttempts: 3,
  baseMs: 100,
  factor: 2,
  jitter: true,
};

interface RetryHooks {
  onAttempt?: (attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const base = policy.baseMs * Math.pow(policy.factor, attempt - 1);
  return policy.jitter ? base * (0.5 + Math.random() * 0.5) : base;
}

/**
 * Runs fn with retries per policy. Returns the result and the attempt number
 * that succeeded, or throws the last error after exhausting attempts.
 */
export async function runWithRetry<T>(
  fn: () => Promise<T> | T,
  policy: RetryPolicy,
  hooks: RetryHooks = {},
): Promise<{ result: T; attempts: number }> {
  const sleep = hooks.sleep ?? realSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    hooks.onAttempt?.(attempt);
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const canRetry = policy.retryable ? policy.retryable(err) : true;
      if (!canRetry || attempt >= policy.maxAttempts) break;
      await sleep(backoffDelay(policy, attempt));
    }
  }
  throw lastErr;
}
