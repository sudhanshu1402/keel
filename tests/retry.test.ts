import { describe, it, expect } from 'vitest';
import { runWithRetry, type RetryPolicy } from '../src/index.js';

const instant = async (): Promise<void> => {};
const policy: RetryPolicy = {
  maxAttempts: 3,
  baseMs: 1,
  factor: 2,
  jitter: false,
};

describe('runWithRetry', () => {
  it('succeeds after transient failures and reports the winning attempt', async () => {
    let n = 0;
    const { result, attempts } = await runWithRetry(
      () => {
        n += 1;
        if (n < 3) throw new Error('flaky');
        return 'ok';
      },
      policy,
      { sleep: instant },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    let n = 0;
    await expect(
      runWithRetry(
        () => {
          n += 1;
          throw new Error('always');
        },
        policy,
        { sleep: instant },
      ),
    ).rejects.toThrow('always');
    expect(n).toBe(3);
  });

  it('does not retry when the error is not retryable', async () => {
    let n = 0;
    const p: RetryPolicy = {
      ...policy,
      retryable: (e) => (e as Error).message !== 'fatal',
    };
    await expect(
      runWithRetry(
        () => {
          n += 1;
          throw new Error('fatal');
        },
        p,
        { sleep: instant },
      ),
    ).rejects.toThrow('fatal');
    expect(n).toBe(1);
  });

  it('succeeds on the first attempt without sleeping', async () => {
    let slept = 0;
    const { attempts } = await runWithRetry(() => 'fast', policy, {
      sleep: async () => {
        slept += 1;
      },
    });
    expect(attempts).toBe(1);
    expect(slept).toBe(0);
  });
});
