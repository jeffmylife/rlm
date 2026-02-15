import { v } from "convex/values";

import { query } from "./_generated/server";

const eventObjectValidator = v.object({
  _id: v.id("run_events"),
  _creationTime: v.number(),
  runId: v.id("runs"),
  seq: v.number(),
  ts: v.number(),
  kind: v.string(),
  summary: v.string(),
  payload: v.optional(v.any()),
});

export const list = query({
  args: {
    runId: v.id("runs"),
    cursor: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    items: v.array(eventObjectValidator),
    nextCursor: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 200, 500));
    const base = ctx.db.query("run_events").withIndex("by_runId_seq", (q) => {
      if (typeof args.cursor === "number") {
        return q.eq("runId", args.runId).gt("seq", args.cursor);
      }
      return q.eq("runId", args.runId);
    });

    const items = await base.take(limit);
    const nextCursor = items.length === limit ? items[items.length - 1]?.seq ?? null : null;
    return {
      items,
      nextCursor,
    };
  },
});

export const streamAll = query({
  args: { runId: v.id("runs") },
  returns: v.array(eventObjectValidator),
  handler: async (ctx, args) => {
    return ctx.db
      .query("run_events")
      .withIndex("by_runId_seq", (q) => q.eq("runId", args.runId))
      .collect();
  },
});
