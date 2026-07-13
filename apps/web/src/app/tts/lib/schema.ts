import { getMediaDuration } from "@/lib/media";
import { createRunPodJobSchema } from "@/lib/schema";
import z from "zod";

export const RunPodTTSJobOutput = z.object({
  audio: z.base64(),
  format: z.string(),
  sample_rate: z.number(),
});

export const RunPodTTSJob = createRunPodJobSchema(RunPodTTSJobOutput);

export const TEXT_MAX_LENGTH = 500;
export const AUDIO_MIN_DURATION = 10;
export const AUDIO_MAX_DURATION = 120;

export const TTSFormSchema = z.object({
  text: z
    .string()
    .min(1, `This field is required`)
    .max(TEXT_MAX_LENGTH, `Text cannot exceed ${TEXT_MAX_LENGTH} characters`),
  referenceText: z.string().min(1, "This field is required"),
  file: z
    .file("Please upload an audio file")
    .mime(
      ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"],
      "You can only select an audio file",
    )
    .refine(
      async (file) => {
        const result = await getMediaDuration(file);
        if (result.isErr()) return true;
        const duration = result.value;
        return duration >= AUDIO_MIN_DURATION && duration <= AUDIO_MAX_DURATION;
      },
      {
        message: `Audio duration must be between ${AUDIO_MIN_DURATION}s and ${AUDIO_MAX_DURATION}s`,
      },
    ),
});
