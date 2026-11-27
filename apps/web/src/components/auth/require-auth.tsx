"use client";

import type { ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending || !session) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
