"use server";

import { runpodApi } from "@/lib/api-server";
import { RunPodCancelledJob, RunPodHealth } from "@/lib/schema";
import { fromPromise } from "neverthrow";
import { done, handleApiError } from "./utils";

export async function cancelJob(jobId: string) {
  const response = await fromPromise(
    runpodApi
      .post(`/cancel/${jobId}`, undefined, {
        output: RunPodCancelledJob,
      })
      .then((r) => r.data),
    handleApiError,
  );

  return done(response);
}

export async function getRunPodServerHealth() {
  const response = await fromPromise(
    runpodApi
      .get("/health", {
        output: RunPodHealth,
      })
      .then((r) => r.data),
    handleApiError,
  );

  return done(response);
}
