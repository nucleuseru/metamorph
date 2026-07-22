"use server";

import { err, ok } from "@/lib/utils";
import { RunPodCancelledJob, RunPodHealth } from "@repo/schemas/runpod";
import { runpodApi } from "./api-server";

export async function cancelJob(jobId: string) {
  const response = await runpodApi.post(`/cancel/${jobId}`, {
    outputSchema: RunPodCancelledJob,
  });

  return response.match((v) => ok(v.data), err);
}

export async function getRunPodServerHealth() {
  const response = await runpodApi.get("/health", {
    outputSchema: RunPodHealth,
  });

  return response.match((v) => ok(v.data.workers), err);
}
