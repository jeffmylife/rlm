import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    filename: v.string(),
    storageId: v.id("_storage"),
    sizeBytes: v.number(),
    mimeType: v.union(v.literal("text/plain"), v.literal("text/markdown")),
    sha256: v.string(),
    status: v.union(v.literal("ready"), v.literal("invalid"), v.literal("deleted")),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  runs: defineTable({
    documentId: v.id("documents"),
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
  })
    .index("by_documentId", ["documentId"])
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"]),

  run_events: defineTable({
    runId: v.id("runs"),
    seq: v.number(),
    ts: v.number(),
    kind: v.string(),
    summary: v.string(),
    payload: v.optional(v.any()),
  }).index("by_runId_seq", ["runId", "seq"]),

  run_artifacts: defineTable({
    runId: v.id("runs"),
    kind: v.union(v.literal("notebook"), v.literal("trace_json"), v.literal("stderr_log")),
    storageId: v.id("_storage"),
    createdAt: v.number(),
  }).index("by_runId", ["runId"]),

  settings: defineTable({
    key: v.union(v.literal("baseSandboxSnapshotId"), v.literal("maxConcurrentRuns")),
    value: v.string(),
  }).index("by_key", ["key"]),
});
