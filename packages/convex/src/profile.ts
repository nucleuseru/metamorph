import { ConvexError, v } from "convex/values";
import { authQuery, internalMutation } from "./function";

export const get = authQuery({
  handler: async (ctx) => {
    const profile = await ctx.db
      .query("profile")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.user.id))
      .unique();

    if (!profile) {
      throw new ConvexError("User has an undeclared profile");
    }

    return profile;
  },
});

export const decrementTTSCredit = internalMutation({
  args: {
    userId: v.string(),
    amount: v.optional(v.number()),
  },
  handler: async (ctx, { userId, amount = 10 }) => {
    const profile = await ctx.db
      .query("profile")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    if (!profile) {
      throw new ConvexError("User has an undeclared profile");
    }

    if (profile.ttsCredits < amount) {
      throw new ConvexError("Insufficient tts credits");
    }

    await ctx.db.patch(profile._id, {
      ttsCredits: profile.ttsCredits - amount,
    });

    return profile.ttsCredits - amount;
  },
});
