# rlm-aisdk

Minimal RLM app using:

- Next.js App Router UI
- Convex for file storage + run/event persistence
- AI SDK for root/sub model calls
- Python REPL worker for recursive tool execution
- Vercel Sandbox backend (optional, env-controlled)

The app goal is simple: upload one large text file (`.txt`/`.md`, up to 100 MB), ask a question, and watch the RLM run timeline live.

## What’s Implemented

- File upload pipeline via Convex upload URLs.
- Run orchestration with persisted statuses (`queued` -> `running` -> terminal state).
- Real-time run event timeline (`run_events` table).
- Artifact persistence (`notebook`, `trace_json`, `stderr_log`) in Convex File Storage.
- Internal run executor action that can run:
  - `local` backend (`RLM_SANDBOX_BACKEND=local`, default)
  - `vercel` backend (`RLM_SANDBOX_BACKEND=vercel`) via `@vercel/sandbox`.
- 14-day retention cleanup functions (`convex/cleanup.ts`).
- Existing RLM harness upgraded with:
  - runtime event sink (`eventSink`)
  - file-based context init (`contextFilePath`)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment values.

Use `.env.local` (Next) and your Convex environment:

- `NEXT_PUBLIC_CONVEX_URL` (required for frontend)
- `AI_GATEWAY_API_KEY` (required for model calls)
- `AI_GATEWAY_BASE_URL` (optional, defaults to Vercel AI Gateway URL from harness)
- `RLM_ROOT_MODEL` (optional, default `openai/gpt-5-mini`)
- `RLM_SUB_MODEL` (optional, default same as root)
- `RLM_SANDBOX_BACKEND` (`local` or `vercel`, default `local`)

For Vercel Sandbox backend, also provide credentials expected by `@vercel/sandbox` (OIDC or token/team/project vars per Vercel docs).

3. Start Convex (generates typed bindings in real deployments):

```bash
npm run convex:dev
```

4. Start Next.js:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Commands

- `npm run dev` - Next.js dev server
- `npm run build:web` - Next.js production build
- `npm run build:lib` - TypeScript build of the original harness library
- `npm run build` - both web + library builds
- `npm run typecheck` - TS typecheck for core `src/`
- `npm run convex:dev` - Convex local/dev session
- `npm run convex:deploy` - Convex deploy
- `npm run demo -- --query "..."` - original CLI harness demo

## Important Paths

- `app/page.tsx` - Upload + run + live timeline UI
- `convex/schema.ts` - Convex tables/indexes
- `convex/files.ts` - upload URL + file commit + list
- `convex/runs.ts` - run lifecycle metadata + events/artifacts mutations/queries
- `convex/runExecutor.ts` - internal node action running sandbox execution
- `convex/runEvents.ts` - timeline event query
- `convex/cleanup.ts` - retention sweep functions
- `sandbox/runner.ts` - local/sandbox runner contract
- `src/harness.ts` - core RLM loop (now emits runtime events)
- `src/pythonWorker.ts` - Python worker client (`contextFilePath` + launcher mode)
- `python/uv_repl_worker.py` - Python REPL worker (`context_file_path` support)

## Notes

- Convex generated files in `convex/_generated/` are checked-in as permissive fallbacks so the repo can build before running Convex codegen.
- The web build currently typechecks Convex functions with `// @ts-nocheck` shims to avoid hard dependency on generated schema types during first bootstrap.
- Upload validation is strict: only `.txt` and `.md`; max 100 MB.
- v1 is intentionally single-user and single-active-run for simplicity.
