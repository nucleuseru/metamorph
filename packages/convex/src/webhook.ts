import { RunPodTTSJob } from "@repo/schemas/runpod";
import z from "zod";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const RunPodWebhookData = z.object({
  type: z.enum(["tts", "fbc", "rvc", "vc"]),
  userId: z.string(),
});

export const runpodWebhook = httpAction(async (ctx, req) => {
  try {
    const authHeader = req.headers.get("authorization")?.split(" ");

    if (
      authHeader?.[0]?.toLowerCase() !== "bearer" ||
      authHeader[1] !== process.env.RUNPOD_WEBHOOK_SECRET
    ) {
      return new Response(null, { status: 401 });
    }

    const data: unknown = await req.json().catch(() => ({}));
    const webhookData = await RunPodWebhookData.parseAsync(data);

    switch (webhookData.type) {
      case "tts": {
        const ttsData = await RunPodTTSJob.parseAsync(data);

        if (ttsData.status === "COMPLETED") {
          await ctx.runMutation(internal.profile.decrementTTSCredit, {
            userId: webhookData.userId,
          });
        }

        break;
      }
      default:
        return new Response(null, { status: 400 });
    }

    return new Response();
  } catch (e) {
    if (e instanceof z.ZodError) {
      return new Response(null, { status: 400 });
    }

    return new Response(null, { status: 500 });
  }
});
