import z from "zod";

export const RunPodCancelledJob = z.object({
  id: z.string(),
  status: z.literal("CANCELLED"),
});

export const RunPodTimedOutJob = z.object({
  id: z.string(),
  error: z.string(),
  status: z.literal("TIMED_OUT"),
});

export const RunPodFailedJob = z.object({
  id: z.string(),
  error: z.string(),
  status: z.literal("FAILED"),
});

export const RunPodPendingJob = z.object({
  id: z.string(),
  status: z.union([
    z.literal("IN_QUEUE"),
    z.literal("IN_PROGRESS"),
    z.literal("RUNNING"),
  ]),
});

export const createRunPodCompletedJobSchema = <T>(output: z.ZodType<T>) =>
  z.object({
    id: z.string(),
    delayTime: z.number(),
    executionTime: z.number(),
    status: z.literal("COMPLETED"),
    output: output,
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
  jobs: z.object({
    completed: z.number(),
    failed: z.number(),
    inProgress: z.number(),
    inQueue: z.number(),
    retried: z.number(),
  }),
  workers: z.object({
    idle: z.number(),
    running: z.number(),
  }),
});
