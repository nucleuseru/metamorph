import { ConvexError, v } from "convex/values";
import { authMutation, authQuery } from "./function";

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

export const decrementTTSCredit = authMutation({
  args: {
    amount: v.optional(v.number()),
  },
  handler: async (ctx, { amount = 10 }) => {
    const profile = await ctx.db
      .query("profile")
      .withIndex("by_userId", (q) => q.eq("userId", ctx.user.id))
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
