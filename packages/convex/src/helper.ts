import { authComponent, createAuth } from "./betterAuth/auth";
import { mutation } from "./function";

const users = [
  { username: "preboi", password: "preboi-acc", credits: 700 },
  { username: "nucleus", password: "nucleus-acc", credits: 1000 },
  { username: "messiahson", password: "messiahson-acc", credits: 1000 },
  { username: "magikclone", password: "magic-clone-acc", credits: 900 },
];

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const { auth } = await authComponent.getAuth(createAuth, ctx);
    await Promise.all(
      users.map(async (user) => {
        const data = await auth.api.signUpEmail({
          body: {
            email: `${user.username}@metamorph.com`,
            name: user.username,
            password: user.password,
            username: user.username,
            displayUsername: user.username,
          },
        });

        await ctx.db.insert("profile", {
          userId: data.user.id,
          ttsCredits: user.credits,
        });
      }),
    );
  },
});
