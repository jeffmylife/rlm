import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Sandbox } from "@vercel/sandbox";

import { RLMHarness } from "../src/harness.js";
import type { RLMRuntimeEvent, RunTrace } from "../src/logging/traceTypes.js";

export interface SandboxRunInput {
  contextFilePath?: string;
  question: string;
  model: string;
  maxIterations: number;
  maxSubcalls: number;
  requestTimeoutMs: number;
  sandboxTimeoutMs: number;
  snapshotId?: string;
  onEvent?: (event: RLMRuntimeEvent) => void | Promise<void>;
}

export interface SandboxRunResult {
  answer: string;
  trace: RunTrace | null;
  stderr: string | null;
  sandboxId: string | null;
  backend: "local" | "vercel";
  newSnapshotId?: string;
  codeVersion?: string;
}

interface SandboxWorkerResult {
  answer: string;
  trace: RunTrace | null;
}

const SANDBOX_WORKSPACE_PROJECT = "/vercel/sandbox/project";
const SANDBOX_WORKSPACE_ROOT = "/vercel/sandbox";
const SANDBOX_CONTEXT_PATH_PROJECT = `${SANDBOX_WORKSPACE_PROJECT}/.tmp/context.txt`;
const SANDBOX_CONTEXT_PATH_ROOT = `${SANDBOX_WORKSPACE_ROOT}/.tmp/context.txt`;

// Bump this when sandbox worker code changes to invalidate cached snapshots.
// Snapshots bake in the source code — if the code changes, the snapshot is stale.
export const SANDBOX_CODE_VERSION = "2";

export async function runRlmInSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  const backend = (process.env.RLM_SANDBOX_BACKEND ?? "local").toLowerCase();
  if (backend === "vercel") {
    return runViaVercelSandbox(input);
  }
  return runLocally(input);
}

async function runLocally(input: SandboxRunInput): Promise<SandboxRunResult> {
  await input.onEvent?.({
    ts: Date.now(),
    kind: "sandbox.local.starting",
    summary: "Starting local sandbox",
    payload: {},
  });

  const result = await runHarness({
    contextFilePath: input.contextFilePath,
    question: input.question,
    model: input.model,
    maxIterations: input.maxIterations,
    maxSubcalls: input.maxSubcalls,
    requestTimeoutMs: input.requestTimeoutMs,
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
  const gitUrl = process.env.RLM_SANDBOX_GIT_URL?.trim();
  const gitRevision = process.env.RLM_SANDBOX_GIT_REVISION?.trim();
  const gitPat = process.env.RLM_SANDBOX_GIT_PAT?.trim();

  const useGitSource = Boolean(gitUrl);
  const useLocalUpload = !useGitSource;

  // Explicit credentials for non-Vercel runtimes (e.g. Convex).
  // Falls back to VERCEL_OIDC_TOKEN auto-detection when not set.
  const vercelToken = process.env.VERCEL_TOKEN?.trim();
  const vercelTeamId = process.env.VERCEL_TEAM_ID?.trim();
  const vercelProjectId = process.env.VERCEL_PROJECT_ID?.trim();

  const createOptions: Parameters<typeof Sandbox.create>[0] = {
    timeout: input.sandboxTimeoutMs,
    runtime: "node24",
  };

  if (vercelToken && vercelTeamId && vercelProjectId) {
    Object.assign(createOptions, {
      token: vercelToken,
      teamId: vercelTeamId,
      projectId: vercelProjectId,
    });
  }

  if (gitUrl) {
    const gitSource: Record<string, string> = {
      type: "git",
      url: gitUrl,
    };
    if (gitRevision) gitSource.revision = gitRevision;
    if (gitPat) {
      gitSource.username = "oauth2";
      gitSource.password = gitPat;
    }
    createOptions.source = gitSource as typeof createOptions.source;
  }

  // Try snapshot-based creation first
  let sandbox: Sandbox;
  let skipNpmInstall = false;
  let newSnapshotId: string | undefined;

  if (input.snapshotId) {
    try {
      await input.onEvent?.({
        ts: Date.now(),
        kind: "sandbox.creating",
        summary: "Creating sandbox from snapshot",
        payload: { snapshotId: input.snapshotId },
      });
      sandbox = await Sandbox.create({
        ...createOptions,
        source: { type: "snapshot", snapshotId: input.snapshotId } as unknown as typeof createOptions.source,
      });
      skipNpmInstall = true;
      await input.onEvent?.({
        ts: Date.now(),
        kind: "sandbox.created",
        summary: "Sandbox created from snapshot",
        payload: { sandboxId: sandbox.sandboxId, fromSnapshot: true },
      });
    } catch {
      // Snapshot failed, fall through to fresh creation
      await input.onEvent?.({
        ts: Date.now(),
        kind: "sandbox.snapshot.failed",
        summary: "Snapshot creation failed, creating fresh sandbox",
        payload: { snapshotId: input.snapshotId },
      });
      await input.onEvent?.({
        ts: Date.now(),
        kind: "sandbox.creating",
        summary: "Creating fresh Vercel sandbox",
        payload: { source: useGitSource ? "git" : "local" },
      });
      sandbox = await Sandbox.create(createOptions);
    }
  } else {
    await input.onEvent?.({
      ts: Date.now(),
      kind: "sandbox.creating",
      summary: "Creating fresh Vercel sandbox",
      payload: { source: useGitSource ? "git" : "local" },
    });
    sandbox = await Sandbox.create(createOptions);
  }

  // Git clone puts files at /vercel/sandbox/, local upload uses /vercel/sandbox/project/
  const workspace = useGitSource ? SANDBOX_WORKSPACE_ROOT : SANDBOX_WORKSPACE_PROJECT;
  const contextPath = useGitSource ? SANDBOX_CONTEXT_PATH_ROOT : SANDBOX_CONTEXT_PATH_PROJECT;

  try {
    if (!skipNpmInstall) {
      if (useLocalUpload) {
        await writeProjectFilesToSandbox(sandbox, workspace, input.contextFilePath);
      } else if (input.contextFilePath) {
        const contextBuffer = await fs.readFile(input.contextFilePath);
        await sandbox.writeFiles([
          { path: contextPath, content: contextBuffer },
        ]);
      }

      await input.onEvent?.({
        ts: Date.now(),
        kind: "sandbox.npm_install.started",
        summary: "Running npm install in sandbox",
        payload: { workspace },
      });
      const install = await sandbox.runCommand({
        cmd: "npm",
        args: ["install", "--no-audit", "--loglevel", "error"],
        cwd: workspace,
      });
      if (install.exitCode !== 0) {
        const installStderr = await install.stderr();
        throw new Error(`Sandbox npm install failed (exit ${install.exitCode}): ${(installStderr || "").slice(0, 2000)}`);
      }
      await input.onEvent?.({
        ts: Date.now(),
        kind: "sandbox.npm_install.completed",
        summary: "npm install completed",
        payload: { workspace },
      });

      await input.onEvent?.({
        ts: Date.now(),
        kind: "sandbox.created",
        summary: "Vercel sandbox created",
        payload: {
          sandboxId: sandbox.sandboxId,
          source: useGitSource ? "git" : "local",
          workspace,
        },
      });

      // Snapshot the sandbox for future reuse (caches node_modules)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const snapshot = await (sandbox as any).snapshot() as { snapshotId: string };
        newSnapshotId = snapshot.snapshotId;
        await input.onEvent?.({
          ts: Date.now(),
          kind: "sandbox.snapshot.created",
          summary: "Sandbox snapshot created for reuse",
          payload: { snapshotId: newSnapshotId },
        });
        // snapshot() stops the sandbox, create a new one from the snapshot
        sandbox = await Sandbox.create({
          ...createOptions,
          source: { type: "snapshot", snapshotId: newSnapshotId } as unknown as typeof createOptions.source,
        });
      } catch {
        // Snapshot failed, continue with existing sandbox (it may still be running)
        await input.onEvent?.({
          ts: Date.now(),
          kind: "sandbox.snapshot.save_failed",
          summary: "Could not save snapshot, continuing without",
          payload: {},
        });
      }
    } else {
      // From snapshot — just write the context file if needed
      if (input.contextFilePath) {
        const contextBuffer = await fs.readFile(input.contextFilePath);
        await sandbox.writeFiles([
          { path: contextPath, content: contextBuffer },
        ]);
      }
    }

    const workerArgs = [
      "tsx",
      "sandbox/runner.ts",
      "--mode",
      "sandbox-worker",
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
    ];
    if (input.contextFilePath) {
      workerArgs.push("--context-file", contextPath);
    }

    const command = await sandbox.runCommand({
      cmd: "npx",
      args: workerArgs,
      cwd: workspace,
      env: buildSandboxEnv(),
    });

    const stdout = await command.stdout();
    const stderr = await command.stderr();

    if (command.exitCode !== 0) {
      await input.onEvent?.({
        ts: Date.now(),
        kind: "sandbox.worker.failed",
        summary: `Worker exited with code ${command.exitCode}`,
        payload: {
          exitCode: command.exitCode,
          stderr: (stderr || "").slice(0, 4000),
          stdout: (stdout || "").slice(0, 2000),
        },
      });
    }

    const workerResult = await parseSandboxWorkerOutput(stdout, stderr, input.onEvent);

    return {
      answer: workerResult.answer,
      trace: workerResult.trace,
      stderr: stderr || null,
      sandboxId: sandbox.sandboxId,
      backend: "vercel",
      newSnapshotId,
      codeVersion: SANDBOX_CODE_VERSION,
    };
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}

async function writeProjectFilesToSandbox(
  sandbox: Sandbox,
  workspace: string,
  contextFilePath?: string,
): Promise<void> {
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
      path: `${workspace}/${entry.relativePath}`,
      content: await fs.readFile(entry.absolutePath),
    })),
  );

  if (contextFilePath) {
    const contextBuffer = await fs.readFile(contextFilePath);
    files.push({
      path: `${workspace}/.tmp/context.txt`,
      content: contextBuffer,
    });
  }

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
  stderr: string,
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
    const stderrPreview = (stderr || "").trim().slice(0, 2000);
    const stdoutPreview = (stdout || "").trim().slice(0, 1000);
    throw new Error(
      `Sandbox worker did not emit a final result payload.\n` +
      `stderr: ${stderrPreview || "(empty)"}\n` +
      `stdout: ${stdoutPreview || "(empty)"}`,
    );
  }

  return result;
}

async function runHarness(input: {
  contextFilePath?: string;
  question: string;
  model: string;
  maxIterations: number;
  maxSubcalls: number;
  requestTimeoutMs: number;
  onEvent?: (event: RLMRuntimeEvent) => void | Promise<void>;
}): Promise<SandboxWorkerResult> {
  let trace: RunTrace | null = null;
  let contextDesc = "[no context file]";
  if (input.contextFilePath) {
    const contextStats = await fs.stat(input.contextFilePath);
    contextDesc = `[context_file size=${contextStats.size} bytes]`;
  }
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
    context: contextDesc,
    contextFilePath: input.contextFilePath,
    question: input.question,
    maxIterations: input.maxIterations,
  });

  const finalTrace = result.trace ?? trace;

  return {
    answer: result.answer,
    trace: finalTrace ?? null,
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
  if (!question) {
    throw new Error("sandbox-worker mode requires --question.");
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
