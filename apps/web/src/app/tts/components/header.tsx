"use client";

import { Badge } from "@/components/ui/badge";
import { useIntervalEffect } from "@/hooks/use-interval-effect";
import { getRunPodServerHealth } from "@/lib/actions";
import { useEffect, useEffectEvent, useState } from "react";

export type ServerStatus = "initializing" | "overloaded" | "active" | "error";

export function Header() {
  const [serverStatus, setServerStatus] =
    useState<ServerStatus>("initializing");

  const pollServerStatus = useEffectEvent(async () => {
    const response = await getRunPodServerHealth();

    if (!response.success) {
      return setServerStatus("error");
    }

    const workers = response.data.workers;

    if (workers.idle === 0 && workers.running === 0) {
      setServerStatus("initializing");
    } else if (workers.idle === 0 && workers.running) {
      setServerStatus("overloaded");
    } else {
      setServerStatus("active");
    }
  });

  useEffect(() => {
    void pollServerStatus();
  }, []);

  useIntervalEffect(() => {
    void pollServerStatus();
  }, 60000);

  return (
    <header className="border-b border-zinc-200 bg-white px-4 py-3 sm:px-6 sm:py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-bold tracking-tight text-xs sm:text-sm uppercase whitespace-nowrap">Metamorph TTS</span>
        <span className="text-zinc-300 text-xs">/</span>
        <span className="text-zinc-500 text-xs font-mono whitespace-nowrap">Synthesizer</span>
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        <span className="text-xs text-zinc-500 font-mono whitespace-nowrap">Server Status:</span>
        <Badge
          variant="outline"
          data-status={serverStatus}
          className="rounded-none font-mono text-[10px] uppercase border px-2 py-0.5 tracking-wider data-[status=active]:border-green-300 data-[status=active]:bg-green-50 data-[status=active]:text-green-800 data-[status=error]:border-red-300 data-[status=error]:bg-red-50 data-[status=error]:text-red-800 data-[status=initializing]:border-yellow-300 data-[status=initializing]:bg-yellow-50 data-[status=initializing]:text-yellow-800 data-[status=overloaded]:border-amber-300 data-[status=overloaded]:bg-amber-50 data-[status=overloaded]:text-amber-800"
        >
          {serverStatus}
        </Badge>
      </div>
    </header>
  );
}
