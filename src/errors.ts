/** Thrown internally when a workflow pauses to wait for an external signal. */
export class PausedError extends Error {
  constructor(public readonly stepName: string) {
    super(`workflow paused at ${stepName}`);
    this.name = 'PausedError';
  }
}

/** Wraps the underlying error when a step exhausts its retries. */
export class StepFailedError extends Error {
  constructor(
    public readonly stepName: string,
    public readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`step ${stepName} failed: ${detail}`);
    this.name = 'StepFailedError';
  }
}
