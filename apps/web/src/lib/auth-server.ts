import "server-only";

import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL;
const CONVEX_SITE_URL = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;

if (!CONVEX_URL) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL must be defined");
}

if (!CONVEX_SITE_URL) {
  throw new Error("NEXT_PUBLIC_CONVEX_SITE_URL must be defined");
}

export const {
  handler,
  getToken,
  fetchAuthQuery,
  fetchAuthAction,
  isAuthenticated,
  preloadAuthQuery,
  fetchAuthMutation,
} = convexBetterAuthNextJs({
  convexUrl: CONVEX_URL,
  convexSiteUrl: CONVEX_SITE_URL,
});
