import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { File } from "./schema";

export const generateUploadUrl = mutation({
  args: {},
  handler: (ctx) => ctx.storage.generateUploadUrl(),
});

export const getFile = query({
  args: { id: v.id("file") },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.id);

    if (!file) {
      throw new ConvexError("File not found.");
    }

    const fileUrl = file.storageId
      ? await ctx.storage.getUrl(file.storageId)
      : null;

    return { ...file, src: fileUrl };
  },
});

export const createFile = internalMutation({
  args: File,
  handler: (ctx, args) => ctx.db.insert("file", args),
});

export const updateFile = internalMutation({
  args: {
    id: v.id("file"),
    status: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: (ctx, args) => {
    return ctx.db.patch("file", args.id, {
      status: args.status,
      sessionId: args.storageId,
    });
  },
});

export const getFileByJobId = internalQuery({
  args: { jobId: v.string() },
  handler: (ctx, args) => {
    return ctx.db
      .query("file")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
  },
});

export const getFilesCount = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("file")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .take(100);
    return files.length;
  },
});
