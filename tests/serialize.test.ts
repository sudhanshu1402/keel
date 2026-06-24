import { describe, it, expect } from 'vitest';
import { writeFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertJsonSafe } from '../src/store/serialize.js';
import { FileStore } from '../src/index.js';

describe('assertJsonSafe', () => {
  it('accepts JSON primitives, plain objects, and arrays', () => {
    expect(() => assertJsonSafe(null, 'v')).not.toThrow();
    expect(() => assertJsonSafe('s', 'v')).not.toThrow();
    expect(() => assertJsonSafe(42, 'v')).not.toThrow();
    expect(() => assertJsonSafe(true, 'v')).not.toThrow();
    expect(() => assertJsonSafe(undefined, 'v')).not.toThrow();
    expect(() =>
      assertJsonSafe({ a: 1, b: [{ c: 'x' }], d: null }, 'v'),
    ).not.toThrow();
  });

  it('rejects a bigint', () => {
    expect(() => assertJsonSafe(10n, 'result')).toThrow(/bigint/);
  });

  it('rejects functions and symbols', () => {
    expect(() => assertJsonSafe(() => 1, 'result')).toThrow(/function/);
    expect(() => assertJsonSafe(Symbol('x'), 'result')).toThrow(/symbol/);
  });

  it('rejects class instances that JSON would silently mangle', () => {
    expect(() => assertJsonSafe(new Date(), 'result')).toThrow(/Date/);
    expect(() => assertJsonSafe(new Map(), 'result')).toThrow(
      /not JSON-serializable/,
    );
  });

  it('points at the offending nested path', () => {
    expect(() => assertJsonSafe({ order: { total: 5n } }, 'result')).toThrow(
      /order\.total/,
    );
  });
});

describe('FileStore corrupt-file handling', () => {
  it('quarantines an unreadable store and refuses to start on top of it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-corrupt-'));
    const path = join(dir, 'store.json');
    writeFileSync(path, '{ this is not valid json', 'utf8');

    expect(() => new FileStore(path)).toThrow(/corrupt/);

    // The bad file was preserved (renamed), never silently discarded.
    const quarantined = readdirSync(dir).filter((f) =>
      f.startsWith('store.json.corrupt-'),
    );
    expect(quarantined.length).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('ignores a leftover torn .tmp file and loads the committed db intact', async () => {
    // FileStore commits via write-temp + fsync + atomic rename. A crash during a
    // flush can leave a half-written `${path}.tmp`, but the live file is only
    // ever the fully-renamed previous version. A reopen must read the committed
    // file and never the torn temp.
    const dir = mkdtempSync(join(tmpdir(), 'keel-tmp-'));
    const path = join(dir, 'store.json');
    const s1 = new FileStore(path);
    await s1.createRun({
      id: 'r1',
      workflowName: 'w',
      status: 'completed',
      input: { ok: true },
      output: 'done',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    });

    // Simulate a crash mid-flush: a half-written temp file is left behind.
    writeFileSync(`${path}.tmp`, '{ "runs": { "r1": { half', 'utf8');

    const s2 = new FileStore(path);
    const run = await s2.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('done');
  });
});
