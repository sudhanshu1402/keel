# Contributing to keel

Thanks for your interest. keel is a small, dependency-free codebase, so getting started is quick.

## Setup

```bash
git clone https://github.com/sudhanshu1402/keel.git
cd keel
npm install
```

## Develop

```bash
npm run typecheck   # type-check without emitting
npm test            # run the vitest suite
npm run test:watch  # watch mode
npm run build       # emit dist/
```

Try the runnable examples:

```bash
npm run example:order              # durable crash/resume demo
npm run example:agent -- "topic" --mock   # durable LLM agent (no Ollama needed)
```

## Ground rules

- **Zero runtime dependencies in the core.** The engine, stores, retry, and providers must not add production deps. Dev dependencies are fine.
- **Tests first.** Every behavior change ships with a test. The suite runs with no network and no external services.
- **Keep it typed and strict.** `npm run typecheck` must pass under the existing strict config.
- **Plain ASCII** in source and docs. No em-dashes, no smart quotes.

## Pull requests

1. Branch from `main`.
2. Make the change with a test that fails before and passes after.
3. Ensure `npm run typecheck && npm test && npm run build` are all green.
4. Open the PR with a short description of the problem and the fix.

## Reporting bugs

Open an issue with a minimal reproduction: the workflow definition, the store/provider used, and what you expected versus what happened.
