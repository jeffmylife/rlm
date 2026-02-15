import fs from "node:fs/promises";
import path from "node:path";

import dotenv from "dotenv";

import { RLMHarness, type RLMContext } from "./harness.js";
import { renderRunTraceNotebook } from "./logging/notebookRenderer.js";
import { writeNotebookFile } from "./logging/notebookWriter.js";
import { type RedactionPolicy, type RunTrace } from "./logging/traceTypes.js";

dotenv.config();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error("AI_GATEWAY_API_KEY is required in environment (for example in .env)");
  }

  const context = await loadContext(args);
  const query = args.get("query") ?? process.env.RLM_QUERY;

  const notebookOut = args.get("notebook-out");
  const notebookTitle = args.get("notebook-title");
  const notebookMaxChars = parseIntSafe(args.get("notebook-max-chars"));
  const notebookPolicy = notebookMaxChars ? buildNotebookPolicy(notebookMaxChars) : undefined;

  let collectedTrace: RunTrace | undefined;

  const harness = new RLMHarness({
    rootModel: args.get("root-model") ?? process.env.RLM_ROOT_MODEL,
    subModel: args.get("sub-model") ?? process.env.RLM_SUB_MODEL,
    maxIterations: parseIntSafe(args.get("max-iterations")) ?? undefined,
    maxTotalSubcalls: parseIntSafe(args.get("max-subcalls")) ?? undefined,
    verbose: Boolean(args.get("verbose")),
    traceCollector: notebookOut
      ? {
          onTrace: (trace) => {
            collectedTrace = trace;
          },
        }
      : undefined,
    redactionPolicy: notebookPolicy,
  });

  const result = await harness.completion({
    context,
    question: query,
  });

  let notebookPath: string | undefined;
  if (notebookOut) {
    const trace = result.trace ?? collectedTrace;
    if (!trace) {
      throw new Error("Notebook output requested, but trace data was not available");
    }

    const notebook = renderRunTraceNotebook({
      trace,
      title: notebookTitle,
      redactionPolicy: notebookPolicy,
    });

    const writeResult = await writeNotebookFile({
      notebook,
      outputTarget: notebookOut,
      runId: trace.runId,
    });

    notebookPath = writeResult.path;
  }

  const output = {
    answer: result.answer,
    iterations: result.iterations.length,
    subcallCount: result.subcallCount,
    executionTimeMs: result.executionTimeMs,
    notebookPath,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function loadContext(args: Map<string, string>): Promise<RLMContext> {
  const contextText = args.get("context") ?? process.env.RLM_CONTEXT;
  if (contextText) {
    return contextText;
  }

  const contextFile = args.get("context-file") ?? process.env.RLM_CONTEXT_FILE;
  if (contextFile) {
    const absolutePath = path.resolve(contextFile);
    const raw = await fs.readFile(absolutePath, "utf8");

    if (absolutePath.endsWith(".json")) {
      return JSON.parse(raw) as RLMContext;
    }

    return raw;
  }

  return [
    "Ada Lovelace worked with Charles Babbage on the Analytical Engine.",
    "The Analytical Engine was a proposed mechanical general-purpose computer.",
    "Prompt question: Who did Ada Lovelace collaborate with?",
  ];
}

function parseArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed.set(key, "true");
      continue;
    }

    parsed.set(key, next);
    i += 1;
  }

  return parsed;
}

function parseIntSafe(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildNotebookPolicy(maxChars: number): Partial<RedactionPolicy> {
  const bounded = Math.max(maxChars, 256);
  const headChars = Math.max(64, Math.floor(bounded * 0.75));
  const tailChars = Math.max(64, bounded - headChars);

  return {
    maxPromptChars: bounded,
    maxContextPreviewChars: bounded,
    maxReplOutputChars: bounded,
    headChars,
    tailChars,
  };
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
