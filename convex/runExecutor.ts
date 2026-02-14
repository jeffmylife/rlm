"use node";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { runRlmInSandbox } from "../sandbox/runner.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SANDBOX_TIMEOUT_MS = 8 * 60 * 1000;

export const execute = internalAction({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    let nextSeq = 1;
    console.log(`[runExecutor] starting run ${args.runId}`);

    const appendEvent = async (event: {
      kind: string;
      summary: string;
      payload?: Record<string, unknown>;
      ts?: number;
    }) => {
      await ctx.runMutation(internal.runs.appendEvent, {
        runId: args.runId,
        seq: nextSeq,
        ts: event.ts ?? Date.now(),
        kind: event.kind,
        summary: event.summary,
        payload: event.payload,
      });
      nextSeq += 1;
    };

    const runBundle = await ctx.runQuery(internal.runs.getForExecution, { runId: args.runId });
    if (!runBundle || !runBundle.run || !runBundle.document) {
      throw new ConvexError("Run or document not found for execution.");
    }

    const { run, document } = runBundle;
    await appendEvent({
      kind: "executor.start",
      summary: "Run executor started",
      payload: {
        runId: args.runId,
        documentId: run.documentId,
      },
    });
    await ctx.runMutation(internal.runs.markRunning, {
      runId: args.runId,
      startedAt,
    });
    await appendEvent({
      kind: "run.status",
      summary: "Run marked as running",
      payload: {
        model: run.model,
        maxIterations: run.maxIterations,
        maxSubcalls: run.maxSubcalls,
      },
    });

    const storageUrl = await ctx.storage.getUrl(document.storageId);
    await appendEvent({
      kind: "storage.url.resolved",
      summary: "Resolved storage URL",
      payload: {
        hasUrl: Boolean(storageUrl),
      },
    });
    if (!storageUrl) {
      await ctx.runMutation(internal.runs.markFailed, {
        runId: args.runId,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        errorCode: "document_unavailable",
        errorMessage: "Document file was not available in storage.",
      });
      return;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-run-"));
    const contextPath = path.join(tempDir, "context.txt");

    try {
      await appendEvent({
        kind: "storage.download.started",
        summary: "Downloading context file",
      });
      const fileResponse = await fetch(storageUrl);
      if (!fileResponse.ok) {
        throw new Error(`Failed to fetch document from storage (${fileResponse.status}).`);
      }
      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      await fs.writeFile(contextPath, buffer);
      await appendEvent({
        kind: "storage.download.completed",
        summary: "Context file downloaded",
        payload: {
          bytes: buffer.length,
        },
      });

      await appendEvent({
        kind: "sandbox.run.started",
        summary: "Invoking sandbox runner",
        payload: {
          backend: process.env.RLM_SANDBOX_BACKEND ?? "local",
        },
      });
      const result = await withTimeout(
        runRlmInSandbox({
          contextFilePath: contextPath,
          question: run.question,
          model: run.model,
          maxIterations: run.maxIterations,
          maxSubcalls: run.maxSubcalls,
          requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
          sandboxTimeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
          notebookTitle: `RLM Run ${args.runId}`,
          onEvent: async (event) => {
            await appendEvent({
              kind: event.kind,
              summary: event.summary,
              payload: event.payload,
              ts: event.ts,
            });
          },
        }),
        DEFAULT_SANDBOX_TIMEOUT_MS,
      );
      await appendEvent({
        kind: "sandbox.run.completed",
        summary: "Sandbox runner completed",
        payload: {
          answerChars: result.answer.length,
          backend: result.backend,
          sandboxId: result.sandboxId ?? null,
        },
      });

      if (result.notebook) {
        const notebookStorageId = await ctx.storage.store(
          new Blob([result.notebook], { type: "application/x-ipynb+json" }),
        );
        await ctx.runMutation(internal.runs.addArtifact, {
          runId: args.runId,
          kind: "notebook",
          storageId: notebookStorageId,
          createdAt: Date.now(),
        });
        await appendEvent({
          kind: "artifact.saved",
          summary: "Notebook artifact saved",
          payload: { kind: "notebook" },
        });
      }

      if (result.trace) {
        const traceStorageId = await ctx.storage.store(
          new Blob([JSON.stringify(result.trace, null, 2) + "\n"], { type: "application/json" }),
        );
        await ctx.runMutation(internal.runs.addArtifact, {
          runId: args.runId,
          kind: "trace_json",
          storageId: traceStorageId,
          createdAt: Date.now(),
        });
        await appendEvent({
          kind: "artifact.saved",
          summary: "Trace artifact saved",
          payload: { kind: "trace_json" },
        });
      }

      if (result.stderr) {
        const stderrStorageId = await ctx.storage.store(
          new Blob([result.stderr], { type: "text/plain" }),
        );
        await ctx.runMutation(internal.runs.addArtifact, {
          runId: args.runId,
          kind: "stderr_log",
          storageId: stderrStorageId,
          createdAt: Date.now(),
        });
        await appendEvent({
          kind: "artifact.saved",
          summary: "Stderr artifact saved",
          payload: { kind: "stderr_log" },
        });
      }

      await ctx.runMutation(internal.runs.markCompleted, {
        runId: args.runId,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        answer: result.answer,
        sandboxId: result.sandboxId ?? undefined,
      });
      await appendEvent({
        kind: "run.completed",
        summary: "Run completed",
        payload: {
          answerChars: result.answer.length,
          backend: result.backend,
          sandboxId: result.sandboxId ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[runExecutor] run ${args.runId} failed`, error);
      const timeoutLike = /timed out|timeout/i.test(message);
      const endedAt = Date.now();

      await ctx.runMutation(internal.runs.markFailed, {
        runId: args.runId,
        endedAt,
        durationMs: endedAt - startedAt,
        errorCode: timeoutLike ? "action_timeout" : "sandbox_create_failed",
        errorMessage: message,
        status: timeoutLike ? "timed_out" : "failed",
      });
      await appendEvent({
        kind: timeoutLike ? "run.timed_out" : "run.failed",
        summary: timeoutLike ? "Run timed out" : "Run failed",
        payload: {
          error: message,
          stack: error instanceof Error ? error.stack ?? null : null,
          sandboxBackend: process.env.RLM_SANDBOX_BACKEND ?? "local",
        },
      });
    } finally {
      await appendEvent({
        kind: "executor.cleanup",
        summary: "Executor cleanup complete",
      });
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[runExecutor] finished run ${args.runId}`);
    }
  },
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Operation timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}
