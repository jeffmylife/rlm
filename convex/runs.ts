import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";

const DEFAULT_MODEL = "openai/gpt-5-mini";
const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_MAX_SUBCALLS = 120;
const MAX_EVENT_PAYLOAD_CHARS = 32_000;

const runObjectValidator = v.object({
  _id: v.id("runs"),
  _creationTime: v.number(),
  documentId: v.optional(v.id("documents")),
  question: v.string(),
  status: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("timed_out"),
    v.literal("cancelled"),
  ),
  model: v.string(),
  maxIterations: v.number(),
  maxSubcalls: v.number(),
  startedAt: v.optional(v.number()),
  endedAt: v.optional(v.number()),
  answer: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  sandboxId: v.optional(v.string()),
  durationMs: v.optional(v.number()),
  createdAt: v.number(),
});

export const start = mutation({
  args: {
    documentId: v.optional(v.id("documents")),
    question: v.string(),
    model: v.optional(v.string()),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    const question = args.question.trim();
    if (!question) {
      throw new ConvexError("Question cannot be empty.");
    }

    if (args.documentId) {
      const document = await ctx.db.get(args.documentId);
      if (!document) {
        throw new ConvexError("Document not found.");
      }
      if (document.status !== "ready") {
        throw new ConvexError("Document is not ready to run.");
      }
    }

    // Cancel runs stuck in queued/running (e.g. from a failed executor)
    const STUCK_THRESHOLD_MS = 60 * 1000; // 1 minute
    const checkTime = Date.now();

    for (const status of ["queued", "running"] as const) {
      const active = await ctx.db
        .query("runs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const run of active) {
        const age = checkTime - run.createdAt;
        if (age > STUCK_THRESHOLD_MS) {
          await ctx.db.patch(run._id, {
            status: "failed",
            endedAt: checkTime,
            durationMs: age,
            errorCode: "stuck_timeout",
            errorMessage: `Run was stuck in "${status}" for ${Math.round(age / 1000)}s and was auto-cancelled.`,
          });
        } else {
          throw new ConvexError("Another run is already queued or running.");
        }
      }
    }

    const now = Date.now();
    const runId = await ctx.db.insert("runs", {
      documentId: args.documentId,
      question,
      status: "queued",
      model: args.model ?? DEFAULT_MODEL,
      maxIterations: DEFAULT_MAX_ITERATIONS,
      maxSubcalls: DEFAULT_MAX_SUBCALLS,
      createdAt: now,
    });

    await ctx.db.insert("run_events", {
      runId,
      seq: 1,
      ts: now,
      kind: "run.queued",
      summary: "Run created and queued",
    });

    await ctx.scheduler.runAfter(0, internal.runExecutor.execute, { runId });

    return runId;
  },
});

export const get = query({
  args: {
    runId: v.id("runs"),
  },
  returns: v.union(runObjectValidator, v.null()),
  handler: async (ctx, args) => {
    return ctx.db.get(args.runId);
  },
});

export const listByDocument = query({
  args: {
    documentId: v.id("documents"),
    limit: v.optional(v.number()),
  },
  returns: v.array(runObjectValidator),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_documentId", (q) => q.eq("documentId", args.documentId))
      .collect();
    return runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },
});

export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(runObjectValidator),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_createdAt")
      .order("desc")
      .take(limit);
    return runs;
  },
});

export const listArtifacts = query({
  args: {
    runId: v.id("runs"),
  },
  returns: v.array(
    v.object({
      _id: v.id("run_artifacts"),
      _creationTime: v.number(),
      runId: v.id("runs"),
      kind: v.union(v.literal("trace_json"), v.literal("stderr_log")),
      storageId: v.id("_storage"),
      createdAt: v.number(),
      url: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const artifacts = await ctx.db
      .query("run_artifacts")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();
    return Promise.all(
      artifacts.map(async (artifact) => ({
        ...artifact,
        url: await ctx.storage.getUrl(artifact.storageId),
      })),
    );
  },
});

export const cancel = mutation({
  args: {
    runId: v.id("runs"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      throw new ConvexError("Run not found.");
    }
    if (run.status !== "queued" && run.status !== "running") {
      throw new ConvexError(`Cannot cancel a run with status "${run.status}".`);
    }
    const now = Date.now();
    await ctx.db.patch(args.runId, {
      status: "failed",
      endedAt: now,
      durationMs: now - run.createdAt,
      errorCode: "cancelled",
      errorMessage: "Run was cancelled by user.",
    });
  },
});

export const getForExecution = internalQuery({
  args: {
    runId: v.id("runs"),
  },
  returns: v.union(
    v.object({
      run: runObjectValidator,
      document: v.union(
        v.object({
          _id: v.id("documents"),
          _creationTime: v.number(),
          filename: v.string(),
          storageId: v.id("_storage"),
          sizeBytes: v.number(),
          mimeType: v.union(v.literal("text/plain"), v.literal("text/markdown")),
          sha256: v.string(),
          status: v.union(v.literal("ready"), v.literal("invalid"), v.literal("deleted")),
          createdAt: v.number(),
        }),
        v.null(),
      ),
      fileUrl: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      return null;
    }
    if (!run.documentId) {
      return { run, document: null, fileUrl: null };
    }
    const document = await ctx.db.get(run.documentId);
    if (!document) {
      return null;
    }
    const fileUrl = await ctx.storage.getUrl(document.storageId);
    return { run, document, fileUrl };
  },
});

export const markRunning = internalMutation({
  args: {
    runId: v.id("runs"),
    startedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "running",
      startedAt: args.startedAt,
    });
  },
});

export const markCompleted = internalMutation({
  args: {
    runId: v.id("runs"),
    endedAt: v.number(),
    durationMs: v.number(),
    answer: v.string(),
    sandboxId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "completed",
      endedAt: args.endedAt,
      durationMs: args.durationMs,
      answer: args.answer,
      sandboxId: args.sandboxId,
    });
  },
});

export const markFailed = internalMutation({
  args: {
    runId: v.id("runs"),
    endedAt: v.number(),
    durationMs: v.number(),
    errorCode: v.string(),
    errorMessage: v.string(),
    status: v.optional(v.union(v.literal("failed"), v.literal("timed_out"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status ?? "failed",
      endedAt: args.endedAt,
      durationMs: args.durationMs,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    });
  },
});

export const appendEvent = internalMutation({
  args: {
    runId: v.id("runs"),
    seq: v.number(),
    ts: v.number(),
    kind: v.string(),
    summary: v.string(),
    payload: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("run_events", {
      runId: args.runId,
      seq: args.seq,
      ts: args.ts,
      kind: args.kind,
      summary: args.summary,
      payload: sanitizePayload(args.payload),
    });
  },
});

export const addArtifact = internalMutation({
  args: {
    runId: v.id("runs"),
    kind: v.union(v.literal("trace_json"), v.literal("stderr_log")),
    storageId: v.id("_storage"),
    createdAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("run_artifacts", {
      runId: args.runId,
      kind: args.kind,
      storageId: args.storageId,
      createdAt: args.createdAt,
    });
  },
});

function sanitizePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) {
    return undefined;
  }
  const serialized = JSON.stringify(payload);
  if (serialized.length <= MAX_EVENT_PAYLOAD_CHARS) {
    return payload;
  }
  return {
    truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, MAX_EVENT_PAYLOAD_CHARS),
  };
}
