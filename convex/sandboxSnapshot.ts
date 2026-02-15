import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

const SNAPSHOT_TTL_MS = 60 * 60 * 1000; // 1 hour

export const getActiveSnapshotId = internalQuery({
  args: {
    codeVersion: v.optional(v.string()),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", "baseSandboxSnapshotId"))
      .unique();
    if (!row) return null;

    try {
      const parsed = JSON.parse(row.value) as {
        snapshotId: string;
        createdAt: number;
        codeVersion?: string;
      };
      if (Date.now() - parsed.createdAt > SNAPSHOT_TTL_MS) {
        return null;
      }
      // Invalidate snapshot if code version changed (new deploy with different code)
      if (args.codeVersion && parsed.codeVersion && parsed.codeVersion !== args.codeVersion) {
        return null;
      }
      return parsed.snapshotId;
    } catch {
      return null;
    }
  },
});

export const setActiveSnapshotId = internalMutation({
  args: {
    snapshotId: v.string(),
    codeVersion: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", "baseSandboxSnapshotId"))
      .unique();

    const value = JSON.stringify({
      snapshotId: args.snapshotId,
      createdAt: Date.now(),
      codeVersion: args.codeVersion,
    });

    if (existing) {
      await ctx.db.patch(existing._id, { value });
    } else {
      await ctx.db.insert("settings", {
        key: "baseSandboxSnapshotId",
        value,
      });
    }
  },
});
