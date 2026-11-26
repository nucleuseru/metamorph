import { Suspense } from "react";

import { RequireAuth } from "@/components/auth/require-auth";
import { StudioView } from "@/components/studio/studio-view";
import { Spinner } from "@/components/ui/spinner";

export default function StudioPage() {
  return (
    <RequireAuth>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24">
            <Spinner className="size-6 text-muted-foreground" />
          </div>
        }
      >
        <StudioView />
      </Suspense>
    </RequireAuth>
  );
}
