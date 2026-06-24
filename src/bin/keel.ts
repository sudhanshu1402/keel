#!/usr/bin/env node
import { runCli } from '../cli.js';

runCli(process.argv.slice(2))
  .then((code) => {
    // dashboard keeps the event loop alive; other commands exit cleanly.
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`keel: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
