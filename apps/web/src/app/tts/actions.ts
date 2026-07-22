"use server";

import { runpodApi } from "@/lib/api-server";
import { fetchAuthQuery } from "@/lib/auth-server";
import { err, ok } from "@/lib/utils";
import { api } from "@repo/convex/api";
import { RunPodPendingJob, RunPodTTSJob } from "@repo/schemas/runpod";
import { TTSFormSchema } from "./lib/schema";

export async function runTTSJob(formData: FormData) {
  const profile = await fetchAuthQuery(api.profile.get);

  if (profile.ttsCredits < 10) return err("Insufficient balance");

  const validationResult = await TTSFormSchema.safeParseAsync({
    text: formData.get("text"),
    file: formData.get("file"),
    referenceText: formData.get("referenceText"),
  });

  if (!validationResult.success) return err("Bad request");

  const { data } = validationResult;
  const webhookUrl = new URL(
    `/api/webhook/runpod?type=tts&userId=${profile.userId}`,
    process.env.NEXT_PUBLIC_SITE_URL,
  ).toString();

  const response = await runpodApi.post("/run", {
    data: {
      webhook: process.env.NODE_ENV === "production" ? webhookUrl : undefined,
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
