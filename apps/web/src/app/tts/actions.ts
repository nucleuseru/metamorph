"use server";

import { runpodApi } from "@/lib/api-server";
import { RunPodPendingJob } from "@/lib/schema";
import { err, ok } from "@/lib/utils";
import { RunPodTTSJob, TTSFormSchema } from "./lib/schema";

export async function runTTSJob(formData: FormData) {
  const validationResult = await TTSFormSchema.safeParseAsync({
    text: formData.get("text"),
    file: formData.get("file"),
    referenceText: formData.get("referenceText"),
  });

  if (!validationResult.success) return err("Bad request");

  const { data } = validationResult;

  const response = await runpodApi.post("/run", {
    data: {
      input: {
        text: data.text,
        references: [
          {
            text: data.referenceText,
            audio: Buffer.from(await data.file.arrayBuffer()).toString(
              "base64",
            ),
          },
        ],
      },
    },
    outputSchema: RunPodPendingJob,
  });

  return response.match((v) => ok(v.data), err);
}

export async function getTTSJobStatus(jobId: string) {
  const response = await runpodApi.get(`/status/${jobId}`, {
    outputSchema: RunPodTTSJob,
  });

  return response.match((v) => ok(v.data), err);
}

// TODO: Implement a web hook to automatically decrement credit on successful jobs
