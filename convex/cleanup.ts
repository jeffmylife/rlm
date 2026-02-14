import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";

const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PruneResult {
  deletedRuns: number;
  deletedDocuments: number;
  retentionDays: number;
  cutoff: number;
}

export const runNow = action({
  args: {},
  handler: async (ctx): Promise<PruneResult> => {
    return ctx.runAction(internal.cleanup.pruneExpired, {
      retentionDays: DEFAULT_RETENTION_DAYS,
    }) as Promise<PruneResult>;
  },
});

export const scheduleDaily = mutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: boolean }> => {
    await ctx.scheduler.runAfter(DAY_MS, internal.cleanup.pruneAndReschedule, {
      retentionDays: DEFAULT_RETENTION_DAYS,
    });
    return { scheduled: true };
  },
});

export const pruneAndReschedule = internalAction({
  args: {
    retentionDays: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PruneResult> => {
    const result = (await ctx.runAction(internal.cleanup.pruneExpired, {
      retentionDays: args.retentionDays ?? DEFAULT_RETENTION_DAYS,
    })) as PruneResult;
    await ctx.scheduler.runAfter(DAY_MS, internal.cleanup.pruneAndReschedule, {
      retentionDays: args.retentionDays ?? DEFAULT_RETENTION_DAYS,
    });
    return result;
  },
});

export const pruneExpired = internalAction({
  args: {
    retentionDays: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PruneResult> => {
    const retentionDays = Math.max(1, args.retentionDays ?? DEFAULT_RETENTION_DAYS);
    const cutoff = Date.now() - retentionDays * DAY_MS;

    const oldRuns = (await ctx.runQuery(internal.cleanup.listExpiredRunIds, { cutoff })) as Id<"runs">[];
    for (const runId of oldRuns) {
      await ctx.runMutation(internal.cleanup.deleteRunCascade, { runId });
    }

    const oldDocuments = (await ctx.runQuery(internal.cleanup.listExpiredDocumentIds, {
      cutoff,
    })) as Id<"documents">[];
    for (const documentId of oldDocuments) {
      await ctx.runMutation(internal.cleanup.deleteDocumentIfUnused, { documentId });
    }

    return {
      deletedRuns: oldRuns.length,
      deletedDocuments: oldDocuments.length,
      retentionDays,
      cutoff,
    };
  },
});

export const listExpiredRunIds = internalQuery({
  args: {
    cutoff: v.number(),
  },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", args.cutoff))
      .take(500);
    return runs.map((run) => run._id);
  },
});

export const listExpiredDocumentIds = internalQuery({
  args: {
    cutoff: v.number(),
  },
  handler: async (ctx, args) => {
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", args.cutoff))
      .take(500);
    return documents.map((document) => document._id);
  },
});

export const deleteRunCascade = internalMutation({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      return;
    }

    const events = await ctx.db
      .query("run_events")
      .withIndex("by_runId_seq", (q) => q.eq("runId", args.runId))
      .collect();
    for (const event of events) {
      await ctx.db.delete(event._id);
    }

    const artifacts = await ctx.db
      .query("run_artifacts")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();
    for (const artifact of artifacts) {
      await ctx.storage.delete(artifact.storageId);
      await ctx.db.delete(artifact._id);
    }

    await ctx.db.delete(args.runId);
  },
});

export const deleteDocumentIfUnused = internalMutation({
  args: {
    documentId: v.id("documents"),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) {
      return;
    }

    const linkedRuns = await ctx.db
      .query("runs")
      .withIndex("by_documentId", (q) => q.eq("documentId", args.documentId))
      .take(1);
    if (linkedRuns.length > 0) {
      return;
    }

    await ctx.storage.delete(document.storageId);
    await ctx.db.patch(args.documentId, { status: "deleted" });
    await ctx.db.delete(args.documentId);
  },
});
