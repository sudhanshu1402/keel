import { FileStore } from './store/file.js';
import { startDashboard } from './dashboard.js';
import type { RunRecord, Store } from './store/types.js';

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
};

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string>;
  errors: string[];
}

// Every keel flag takes a value (--store, --db, --port, --host). A bare
// trailing flag or one followed by another flag is a usage error rather than a
// silently-dropped option, so `keel runs --store` fails loudly instead of
// quietly falling back to the default store.
function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const errors: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = rest[i + 1];
        if (next === undefined || next.startsWith('--')) {
          errors.push(`flag --${name} requires a value (use --${name} <value> or --${name}=<value>)`);
        } else {
          flags[name] = next;
          i++;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags, errors };
}

async function resolveStore(
  flags: Record<string, string>,
): Promise<Store> {
  if (typeof flags.db === 'string') {
    const { SqliteStore } = await import('./store/sqlite.js');
    return new SqliteStore(flags.db);
  }
  const path = typeof flags.store === 'string' ? flags.store : 'keel-data/keel.json';
  return new FileStore(path);
}

const USAGE = `keel - durable execution control plane

Usage:
  keel runs [--store <file.json>] [--db <file.sqlite>]
  keel inspect <runId> [--store ...] [--db ...]
  keel resume <runId> [--store ...] [--db ...]
  keel cancel <runId> [--store ...] [--db ...]
  keel signal <runId> <name> [jsonValue] [--store ...] [--db ...]
  keel dashboard [--port <n>] [--store ...] [--db ...]

The store defaults to keel-data/keel.json. resume and signal mark a run for
your running Worker or Supervisor to pick up; they do not execute workflow
code themselves (that lives in your app).`;

function statusLine(r: RunRecord): string {
  return `${r.id}  ${r.status.padEnd(9)}  ${r.workflowName}`;
}

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO,
): Promise<number> {
  const { command, positionals, flags, errors } = parseArgs(argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }

  if (errors.length > 0) {
    for (const e of errors) io.err(e);
    return 1;
  }

  if (command === 'runs') {
    const store = await resolveStore(flags);
    const runs = (await store.listRuns()).sort((a, b) => b.createdAt - a.createdAt);
    if (runs.length === 0) {
      io.out('no runs');
      return 0;
    }
    for (const r of runs) io.out(statusLine(r));
    return 0;
  }

  if (command === 'inspect') {
    const id = positionals[0];
    if (!id) {
      io.err('usage: keel inspect <runId>');
      return 1;
    }
    const store = await resolveStore(flags);
    const run = await store.getRun(id);
    if (!run) {
      io.err(`run ${id} not found`);
      return 1;
    }
    io.out(statusLine(run));
    if (run.error) io.out(`  error: ${run.error}`);
    const steps = (await store.listSteps(id)).sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    for (const s of steps) {
      const extra: string[] = [`attempts=${s.attempts}`];
      if (s.tokensIn != null || s.tokensOut != null) {
        extra.push(`tokens=${s.tokensIn ?? 0}/${s.tokensOut ?? 0}`);
      }
      if (s.wakeAt) extra.push(`wakeAt=${s.wakeAt}`);
      io.out(`  [${s.status}] ${s.name} (${extra.join(' ')})`);
      if (s.error) io.out(`    error: ${s.error}`);
    }
    return 0;
  }

  if (command === 'resume') {
    const id = positionals[0];
    if (!id) {
      io.err('usage: keel resume <runId>');
      return 1;
    }
    const store = await resolveStore(flags);
    const run = await store.getRun(id);
    if (!run) {
      io.err(`run ${id} not found`);
      return 1;
    }
    if (run.status !== 'failed' && run.status !== 'paused') {
      io.err(`run ${id} is ${run.status}; only failed or paused runs can be requeued`);
      return 1;
    }
    await store.updateRun(id, { status: 'queued', updatedAt: Date.now() });
    io.out(`requeued ${id}; a running Worker will pick it up`);
    return 0;
  }

  if (command === 'cancel') {
    const id = positionals[0];
    if (!id) {
      io.err('usage: keel cancel <runId>');
      return 1;
    }
    const store = await resolveStore(flags);
    const run = await store.getRun(id);
    if (!run) {
      io.err(`run ${id} not found`);
      return 1;
    }
    if (
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      io.err(`run ${id} is already ${run.status}; nothing to cancel`);
      return 1;
    }
    await store.updateRun(id, { status: 'cancelled', updatedAt: Date.now() });
    io.out(`cancelled ${id}`);
    return 0;
  }

  if (command === 'signal') {
    const [id, name, rawValue] = positionals;
    if (!id || !name) {
      io.err('usage: keel signal <runId> <name> [jsonValue]');
      return 1;
    }
    const store = await resolveStore(flags);
    const run = await store.getRun(id);
    if (!run) {
      io.err(`run ${id} not found`);
      return 1;
    }
    let value: unknown = undefined;
    if (rawValue !== undefined) {
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }
    }
    await store.saveSignal({ runId: id, name, value, createdAt: Date.now() });
    if (run.status === 'paused') {
      await store.updateRun(id, { status: 'queued', updatedAt: Date.now() });
      io.out(`signal "${name}" stored and ${id} requeued for a Worker`);
    } else {
      io.out(`signal "${name}" stored for ${id}`);
    }
    return 0;
  }

  if (command === 'dashboard') {
    let port = 4500;
    if (flags.port !== undefined) {
      const n = Number(flags.port);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        io.err(`invalid --port "${flags.port}": must be an integer between 0 and 65535`);
        return 1;
      }
      port = n;
    }
    const store = await resolveStore(flags);
    const { port: bound } = await startDashboard({ store, port });
    io.out(`keel dashboard on http://127.0.0.1:${bound}`);
    return 0;
  }

  io.err(`unknown command: ${command}`);
  io.err(USAGE);
  return 1;
}
