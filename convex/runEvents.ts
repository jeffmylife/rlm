import { v } from "convex/values";

import { query } from "./_generated/server";

export const list = query({
  args: {
    runId: v.id("runs"),
    cursor: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
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
