"use client";

import { auth } from "@/lib/auth-client";
import {
  AuthClient,
  ConvexBetterAuthProvider,
} from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL ?? "", {
  expectAuth: true,
});

export function ConvexClientProvider({
  children,
  initialToken,
}: {
  children: React.ReactNode;
  initialToken?: string | null;
}) {
  return (
    <ConvexBetterAuthProvider
      client={convex}
      initialToken={initialToken}
      authClient={auth as unknown as AuthClient}
    >
      {children}
    </ConvexBetterAuthProvider>
  );
}
