"use client";

import { Badge } from "@/components/ui/badge";
import { api } from "@repo/convex/api";
import { useQuery } from "convex/react";

export type ServerStatus = "initializing" | "overloaded" | "active" | "error";

export function Header() {
  const profile = useQuery(api.profile.get);

  return (
    <header className="border-border bg-card flex justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
      <h1 className="text-lg font-bold tracking-tight">METAMORPH TTS</h1>
      <Badge
        variant="outline"
        className="rounded-none border px-2 py-0.5 text-xs tracking-wider uppercase"
      >
        {profile?.ttsCredits ?? 0} Credits
      </Badge>
    </header>
  );
}
