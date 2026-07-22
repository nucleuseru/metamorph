import z from "zod";

export const RunPodCancelledJob = z.object({
  id: z.string(),
  status: z.literal("CANCELLED"),
});

export const RunPodTimedOutJob = z.object({
  id: z.string(),
  status: z.literal("TIMED_OUT"),
});

export const RunPodFailedJob = z.object({
  id: z.string(),
  status: z.literal("FAILED"),
});

export const RunPodPendingJob = z.object({
  id: z.string(),
  status: z.union([z.literal("IN_QUEUE"), z.literal("IN_PROGRESS")]),
});

export const createRunPodCompletedJobSchema = <T>(output: z.ZodType<T>) =>
  z.object({
    output,
    id: z.string(),
    status: z.literal("COMPLETED"),
  });

export const createRunPodJobSchema = <T>(output: z.ZodType<T>) =>
  z.union([
    RunPodFailedJob,
    RunPodPendingJob,
    RunPodTimedOutJob,
    RunPodCancelledJob,
    createRunPodCompletedJobSchema(output),
  ]);

export const RunPodHealth = z.object({
  workers: z.object({
    idle: z.number(),
    ready: z.number(),
    running: z.number(),
    unhealthy: z.number(),
    throttled: z.number(),
    initializing: z.number(),
  }),
});

export const RunPodTTSJobOutput = z.object({
  audio: z.base64(),
  format: z.string(),
  sample_rate: z.number(),
});

export const RunPodTTSJob = createRunPodJobSchema(RunPodTTSJobOutput);
