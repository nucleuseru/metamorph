import "./env-config";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { oneTap } from "better-auth/plugins";
import { db } from "./db";

const dbName = (name: string) =>
  `${process.env.NEXT_PUBLIC_PROJECT_NAME || "metamorph"}_${name}`;

export const auth = betterAuth({
  user: {
    modelName: dbName("user"),
  },
  session: {
    modelName: dbName("session"),
  },
  account: {
    modelName: dbName("account"),
  },
  verification: {
    modelName: dbName("verification"),
  },
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  socialProviders: {
    google: {
      clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  plugins: [oneTap(), nextCookies()],
});
