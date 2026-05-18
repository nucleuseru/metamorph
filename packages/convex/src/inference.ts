import { ConvexError, v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { action, httpAction } from "./_generated/server";

export interface RunPodData<T = undefined> {
  id: string;
  output: T;
  error?: unknown;
  status: "IN_QUEUE" | "IN_PROGRESS" | "FAILED" | "COMPLETED" | "CANCELLED";
}

export const cloneVoice = action({
  args: {
    text: v.string(),
    ref_text: v.string(),
    sessionId: v.string(),
    ref_audio_storage_id: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const files = await ctx.runQuery(api.file.getFilesCount, {
      sessionId: args.sessionId,
    });

    if (files >= 100) {
      throw new ConvexError(
        "Cannot generate more than 100 audios per session.",
      );
    }

    const ref_audio = await ctx.storage.getUrl(args.ref_audio_storage_id);

    if (!ref_audio) {
      throw new ConvexError("Reference audio not found.");
    }

    const response = await fetch(process.env.RUNPOD_TTS_API_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RUNPOD_API_KEY!}`,
      },
      body: JSON.stringify({
        input: {
          ref_audio,
          task: "generate",
          text: args.text,
          ref_text: args.ref_text,
          convex_url: process.env.CONVEX_CLOUD_URL!,
          upload_url_fn: "file:generateUploadUrl",
        },
        webhook: `${process.env.CONVEX_SITE_URL!}/webhook/audio/tts`,
      }),
    });

    if (!response.ok) {
      throw new ConvexError(
        `HTTP error! status: ${response.status.toString()}`,
      );
    }

    const data = (await response.json()) as RunPodData;

    const fileId: Id<"file"> = await ctx.runMutation(internal.file.createFile, {
      jobId: data.id,
      sessionId: args.sessionId,
      status: "generating",
    });

    return fileId;
  },
});

export const webhookTts = httpAction(async (ctx, request) => {
  const data = (await request.json()) as RunPodData<{
    storage_ids: Id<"_storage">[];
  }>;
  const file = await ctx.runQuery(internal.file.getFileByJobId, {
    jobId: data.id,
  });

  if (!file) return new Response();

  if (data.status === "COMPLETED") {
    await ctx.runMutation(internal.file.updateFile, {
      id: file._id,
      status: "completed",
      storageId: data.output.storage_ids[0],
    });
  } else {
    await ctx.runMutation(internal.file.updateFile, {
      id: file._id,
      status: "failed",
    });
  }

  return new Response();
});
