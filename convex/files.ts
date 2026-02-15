import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const SUPPORTED_MIME_TYPES = new Set(["text/plain", "text/markdown"]);
const SUPPORTED_EXTENSIONS = [".txt", ".md"];

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return ctx.storage.generateUploadUrl();
  },
});

export const commitUpload = mutation({
  args: {
    storageId: v.id("_storage"),
    filename: v.string(),
    sizeBytes: v.number(),
    mimeType: v.string(),
    sha256: v.string(),
  },
  returns: v.id("documents"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const normalizedFilename = args.filename.trim();
    const normalizedMime = args.mimeType.trim().toLowerCase();

    const hasSupportedExtension = SUPPORTED_EXTENSIONS.some((ext) =>
      normalizedFilename.toLowerCase().endsWith(ext),
    );

    if (args.sizeBytes <= 0 || args.sizeBytes > MAX_FILE_BYTES) {
      throw new ConvexError(`File size must be between 1 byte and ${MAX_FILE_BYTES} bytes.`);
    }

    if (!SUPPORTED_MIME_TYPES.has(normalizedMime) || !hasSupportedExtension) {
      await ctx.db.insert("documents", {
        filename: normalizedFilename,
        storageId: args.storageId,
        sizeBytes: args.sizeBytes,
        mimeType: "text/plain",
        sha256: args.sha256,
        status: "invalid",
        createdAt: now,
      });
      throw new ConvexError("Only .txt and .md files are supported.");
    }

    const metadata = await ctx.storage.getMetadata(args.storageId);
    if (metadata?.size !== undefined && metadata.size !== args.sizeBytes) {
      throw new ConvexError("Uploaded file size does not match committed metadata.");
    }

    return ctx.db.insert("documents", {
      filename: normalizedFilename,
      storageId: args.storageId,
      sizeBytes: args.sizeBytes,
      mimeType: normalizedMime === "text/markdown" ? "text/markdown" : "text/plain",
      sha256: args.sha256,
      status: "ready",
      createdAt: now,
    });
  },
});

export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(
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
  ),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
    return ctx.db.query("documents").withIndex("by_createdAt").order("desc").take(limit);
  },
});

export const get = query({
  args: {
    documentId: v.id("documents"),
  },
  returns: v.union(
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
  handler: async (ctx, args) => {
    return ctx.db.get(args.documentId);
  },
});

export const getStorageUrl = query({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    return ctx.storage.getUrl(args.storageId);
  },
});
