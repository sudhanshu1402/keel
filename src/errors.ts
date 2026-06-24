/** Thrown internally when a workflow pauses to wait for an external signal. */
export class PausedError extends Error {
  constructor(public readonly stepName: string) {
    super(`workflow paused at ${stepName}`);
    this.name = 'PausedError';
  }
}

/**
 * Thrown on resume when the handler's step order no longer matches what was
 * recorded. A workflow's code was changed (a step renamed, reordered, or
 * removed) underneath a run that is still in flight, so the persisted history
 * can no longer be replayed safely.
 */
export class DivergenceError extends Error {
  constructor(
    public readonly index: number,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `replay divergence at step ${index}: expected "${expected}", got "${actual}". ` +
        `The workflow code changed under a running execution.`,
    );
    this.name = 'DivergenceError';
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

/** Thrown internally when a run is cancelled while it is executing. */
export class CancelledError extends Error {
  constructor(public readonly runId: string) {
    super(`run ${runId} was cancelled`);
    this.name = 'CancelledError';
  }
}

/** Thrown when a step does not settle within its configured `timeoutMs`. */
export class TimeoutError extends Error {
  constructor(
    public readonly stepName: string,
    public readonly timeoutMs: number,
  ) {
    super(`step ${stepName} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown on resume when the registered workflow's `version` differs from the
 * version pegged on the run. The workflow was intentionally evolved, so the old
 * run cannot be safely replayed against the new code. Migrate or drain the old
 * runs before bumping the version.
 */
export class WorkflowVersionError extends Error {
  constructor(
    public readonly workflowName: string,
    public readonly runVersion: number,
    public readonly codeVersion: number,
  ) {
    super(
      `workflow ${workflowName} run was created at version ${runVersion} but the ` +
        `registered code is version ${codeVersion}; cannot resume across versions.`,
    );
    this.name = 'WorkflowVersionError';
  }
}
