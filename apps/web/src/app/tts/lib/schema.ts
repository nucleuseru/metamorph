import z from "zod";

export const RunPodTTSJobOutput = z.object({
  audio: z.base64(),
  format: z.string(),
  sample_rate: z.number(),
});

export const TEXT_MIN_LENGTH = 10;
export const TEXT_MAX_LENGTH = 500;

export const TTSFormSchema = z.object({
  text: z
    .string()
    .min(TEXT_MIN_LENGTH, `Text must be at least ${TEXT_MIN_LENGTH} characters`)
    .max(TEXT_MAX_LENGTH, `Text cannot exceed ${TEXT_MAX_LENGTH} characters`),
  referenceText: z.string().min(1, "Reference text is required"),
  file: z
    .file("Please upload an audio file")
    .max(1024 * 1024 * 6, "Audio file cannot be bigger than 6mb")
    .mime(
      ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"],
      "You can only select an audio file",
    ),
});
