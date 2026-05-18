import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const File = {
  name: v.string(),
  jobId: v.string(),
  status: v.string(),
  sessionId: v.string(),
  storageId: v.optional(v.id("_storage")),
};

export const table = {
  file: defineTable(File)
    .index("by_sessionId", ["sessionId", "status"])
    .index("by_jobId", ["jobId"]),
};

export default defineSchema(table);
