import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Sandbox } from "@vercel/sandbox";

import { RLMHarness } from "../src/harness.js";
import { renderRunTraceNotebook } from "../src/logging/notebookRenderer.js";
import type { RLMRuntimeEvent, RunTrace } from "../src/logging/traceTypes.js";

export interface SandboxRunInput {
  contextFilePath: string;
  question: string;
  model: string;
  maxIterations: number;
  maxSubcalls: number;
  requestTimeoutMs: number;
  sandboxTimeoutMs: number;
  notebookTitle?: string;
  onEvent?: (event: RLMRuntimeEvent) => void | Promise<void>;
}

export interface SandboxRunResult {
  answer: string;
  trace: RunTrace | null;
  notebook: string | null;
  stderr: string | null;
  sandboxId: string | null;
  backend: "local" | "vercel";
}

interface SandboxWorkerResult {
  answer: string;
  trace: RunTrace | null;
  notebook: string | null;
}

const SANDBOX_WORKSPACE = "/vercel/sandbox/project";
const SANDBOX_CONTEXT_PATH = `${SANDBOX_WORKSPACE}/.tmp/context.txt`;

export async function runRlmInSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  const backend = (process.env.RLM_SANDBOX_BACKEND ?? "local").toLowerCase();
  if (backend === "vercel") {
    return runViaVercelSandbox(input);
  }
  return runLocally(input);
}

async function runLocally(input: SandboxRunInput): Promise<SandboxRunResult> {
  const result = await runHarness({
    contextFilePath: input.contextFilePath,
    question: input.question,
    model: input.model,
    maxIterations: input.maxIterations,
    maxSubcalls: input.maxSubcalls,
    requestTimeoutMs: input.requestTimeoutMs,
    notebookTitle: input.notebookTitle,
    onEvent: input.onEvent,
  });

  return {
    ...result,
    stderr: null,
    sandboxId: null,
    backend: "local",
  };
}

async function runViaVercelSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  const sourceSnapshotId = process.env.RLM_SANDBOX_SNAPSHOT_ID?.trim();
  const sandbox = await Sandbox.create(
    sourceSnapshotId
      ? {
          source: {
            type: "snapshot",
            snapshotId: sourceSnapshotId,
          },
          timeout: input.sandboxTimeoutMs,
          runtime: "node24",
        }
      : {
          timeout: input.sandboxTimeoutMs,
          runtime: "node24",
        },
  );

  try {
    if (sourceSnapshotId) {
      // Snapshot already has project files + node_modules — only write the context file
      const contextBuffer = await fs.readFile(input.contextFilePath);
      await sandbox.writeFiles([
        { path: SANDBOX_CONTEXT_PATH, content: contextBuffer },
      ]);
    } else {
      // No snapshot — upload entire project and install deps
      await writeProjectFilesToSandbox(sandbox, input.contextFilePath);

      const install = await sandbox.runCommand({
        cmd: "npm",
        args: ["install", "--no-audit", "--loglevel", "error"],
        cwd: SANDBOX_WORKSPACE,
      });
      if (install.exitCode !== 0) {
        throw new Error(`Sandbox npm install failed with exit code ${install.exitCode}.`);
      }
    }

    await input.onEvent?.({
      ts: Date.now(),
      kind: "sandbox.created",
      summary: "Vercel sandbox created",
      payload: {
        sandboxId: sandbox.sandboxId,
        sourceSnapshotId: sourceSnapshotId ?? null,
      },
    });

    const command = await sandbox.runCommand({
      cmd: "npx",
      args: [
        "tsx",
        "sandbox/runner.ts",
        "--mode",
        "sandbox-worker",
        "--context-file",
        SANDBOX_CONTEXT_PATH,
        "--question",
        input.question,
        "--model",
        input.model,
        "--max-iterations",
        String(input.maxIterations),
        "--max-subcalls",
        String(input.maxSubcalls),
        "--request-timeout-ms",
        String(input.requestTimeoutMs),
      ],
      cwd: SANDBOX_WORKSPACE,
      env: buildSandboxEnv(),
    });

    const stdout = await command.stdout();
    const stderr = await command.stderr();
    const workerResult = await parseSandboxWorkerOutput(stdout, input.onEvent);

    return {
      answer: workerResult.answer,
      trace: workerResult.trace,
      notebook: workerResult.notebook,
      stderr: stderr || null,
      sandboxId: sandbox.sandboxId,
      backend: "vercel",
    };
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}

async function writeProjectFilesToSandbox(sandbox: Sandbox, contextFilePath: string): Promise<void> {
  const repoRoot = process.cwd();
  const entries = await collectProjectFiles(repoRoot, [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "src",
    "python",
    "sandbox",
  ]);

  const files = await Promise.all(
    entries.map(async (entry) => ({
      path: `${SANDBOX_WORKSPACE}/${entry.relativePath}`,
      content: await fs.readFile(entry.absolutePath),
    })),
  );

  const contextBuffer = await fs.readFile(contextFilePath);
  files.push({
    path: SANDBOX_CONTEXT_PATH,
    content: contextBuffer,
  });

  await sandbox.writeFiles(files);
}

async function collectProjectFiles(
  rootDir: string,
  seeds: string[],
): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const collected: Array<{ absolutePath: string; relativePath: string }> = [];

  for (const seed of seeds) {
    const absoluteSeed = path.resolve(rootDir, seed);
    const stats = await fs.stat(absoluteSeed);
    if (stats.isFile()) {
      collected.push({
        absolutePath: absoluteSeed,
        relativePath: path.relative(rootDir, absoluteSeed),
      });
      continue;
    }

    const nested = await walkDirectory(absoluteSeed);
    for (const absolutePath of nested) {
      collected.push({
        absolutePath,
        relativePath: path.relative(rootDir, absolutePath),
      });
    }
  }

  return collected;
}

async function walkDirectory(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function buildSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {
    RLM_PYTHON_LAUNCHER: process.env.RLM_SANDBOX_PYTHON_LAUNCHER ?? "python3",
  };

  const passthrough = [
    "AI_GATEWAY_API_KEY",
    "AI_GATEWAY_BASE_URL",
    "RLM_ROOT_MODEL",
    "RLM_SUB_MODEL",
    "RLM_SANDBOX_BACKEND",
  ];

  for (const key of passthrough) {
    const value = process.env[key];
    if (value && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

async function parseSandboxWorkerOutput(
  stdout: string,
  onEvent?: (event: RLMRuntimeEvent) => void | Promise<void>,
): Promise<SandboxWorkerResult> {
  const lines = stdout.split(/\r?\n/);
  let result: SandboxWorkerResult | null = null;

  for (const line of lines) {
    if (line.startsWith("RLM_EVENT\t")) {
      const payload = line.slice("RLM_EVENT\t".length);
      if (!payload) {
        continue;
      }
      const event = JSON.parse(payload) as RLMRuntimeEvent;
      await onEvent?.(event);
      continue;
    }
    if (line.startsWith("RLM_RESULT\t")) {
      const payload = line.slice("RLM_RESULT\t".length);
      if (!payload) {
        continue;
      }
      result = JSON.parse(payload) as SandboxWorkerResult;
    }
  }

  if (!result) {
    throw new Error("Sandbox worker did not emit a final result payload.");
  }

  return result;
}

async function runHarness(input: {
  contextFilePath: string;
  question: string;
  model: string;
  maxIterations: number;
  maxSubcalls: number;
  requestTimeoutMs: number;
  notebookTitle?: string;
  onEvent?: (event: RLMRuntimeEvent) => void | Promise<void>;
}): Promise<SandboxWorkerResult> {
  let trace: RunTrace | null = null;
  const contextStats = await fs.stat(input.contextFilePath);
  const harness = new RLMHarness({
    rootModel: input.model,
    subModel: input.model,
    maxIterations: input.maxIterations,
    maxTotalSubcalls: input.maxSubcalls,
    requestTimeoutMs: input.requestTimeoutMs,
    traceCollector: {
      onTrace: (value) => {
        trace = value;
      },
    },
    eventSink: input.onEvent,
  });

  const result = await harness.completion({
    context: `[context_file size=${contextStats.size} bytes]`,
    contextFilePath: input.contextFilePath,
    rootPrompt: input.question,
    maxIterations: input.maxIterations,
  });

  const finalTrace = result.trace ?? trace;
  const notebook =
    finalTrace &&
    JSON.stringify(
      renderRunTraceNotebook({
        trace: finalTrace,
        title: input.notebookTitle ?? "RLM Run Replay",
      }),
      null,
      2,
    ) + "\n";

  return {
    answer: result.answer,
    trace: finalTrace ?? null,
    notebook: notebook ?? null,
  };
}

function parseCliArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      parsed.set(key, "true");
      continue;
    }
    parsed.set(key, value);
    index += 1;
  }
  return parsed;
}

async function runCli(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const mode = args.get("mode");
  if (mode !== "sandbox-worker") {
    return;
  }

  const contextFilePath = args.get("context-file");
  const question = args.get("question");
  if (!contextFilePath || !question) {
    throw new Error("sandbox-worker mode requires --context-file and --question.");
  }

  const model = args.get("model") ?? process.env.RLM_ROOT_MODEL ?? "openai/gpt-5-mini";
  const maxIterations = Number.parseInt(args.get("max-iterations") ?? "12", 10);
  const maxSubcalls = Number.parseInt(args.get("max-subcalls") ?? "120", 10);
  const requestTimeoutMs = Number.parseInt(args.get("request-timeout-ms") ?? "120000", 10);

  const result = await runHarness({
    contextFilePath,
    question,
    model,
    maxIterations,
    maxSubcalls,
    requestTimeoutMs,
    onEvent: (event) => {
      process.stdout.write(`RLM_EVENT\t${JSON.stringify(event)}\n`);
    },
  });

  process.stdout.write(`RLM_RESULT\t${JSON.stringify(result)}\n`);
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
