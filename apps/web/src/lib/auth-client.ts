import "client-only";

import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const auth = createAuthClient({
  plugins: [convexClient(), usernameClient()],
});
