import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";

const DEFAULT_MODEL = "openai/gpt-5-mini";
const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_MAX_SUBCALLS = 120;
const MAX_EVENT_PAYLOAD_CHARS = 32_000;

export const start = mutation({
  args: {
    documentId: v.id("documents"),
    question: v.string(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const question = args.question.trim();
    if (!question) {
      throw new ConvexError("Question cannot be empty.");
    }

    const document = await ctx.db.get(args.documentId);
    if (!document) {
      throw new ConvexError("Document not found.");
    }
    if (document.status !== "ready") {
      throw new ConvexError("Document is not ready to run.");
    }

    const activeQueued = await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .first();
    const activeRunning = await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .first();
    if (activeQueued || activeRunning) {
      throw new ConvexError("Another run is already queued or running.");
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
  handler: async (ctx, args) => {
    return ctx.db.get(args.runId);
  },
});

export const listByDocument = query({
  args: {
    documentId: v.id("documents"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_documentId", (q) => q.eq("documentId", args.documentId))
      .collect();
    return runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },
});

export const listArtifacts = query({
  args: {
    runId: v.id("runs"),
  },
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

export const getForExecution = internalQuery({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      return null;
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
    kind: v.union(v.literal("notebook"), v.literal("trace_json"), v.literal("stderr_log")),
    storageId: v.id("_storage"),
    createdAt: v.number(),
  },
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
