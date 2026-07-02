"use server";

import { runpodApi } from "@/lib/api-server";
import { createRunPodJobSchema, RunPodPendingJob } from "@/lib/schema";
import { done, handleApiError } from "@/lib/utils";
import { fromAsyncThrowable, fromPromise } from "neverthrow";
import { RunPodTTSJobOutput, TTSFormSchema } from "./schema";

export async function runTTSJob(formData: FormData) {
  const run = fromAsyncThrowable(async () => {
    const data = await TTSFormSchema.parseAsync({
      text: formData.get("text"),
      file: formData.get("file"),
      referenceText: formData.get("referenceText"),
    });

    const response = await runpodApi.post(
      "/run",
      {
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
      { output: RunPodPendingJob },
    );

    return response.data;
  }, handleApiError);

  return done(await run());
}

export async function getTTSJobStatus(jobId: string) {
  const response = await fromPromise(
    runpodApi
      .get(`/status/${jobId}`, {
        output: createRunPodJobSchema(RunPodTTSJobOutput),
      })
      .then((r) => r.data),
    handleApiError,
  );

  return done(response);
}
