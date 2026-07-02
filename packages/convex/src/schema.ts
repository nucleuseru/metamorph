import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const Profile = {
  userId: v.string(),
  ttsCredits: v.number(),
};

export const table = {
  profile: defineTable(Profile).index("by_userId", ["userId"]),
};

export default defineSchema(table);
