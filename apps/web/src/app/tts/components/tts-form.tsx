"use client";

import { Button } from "@/components/ui/button";
import { usePollEffect } from "@/hooks/use-poll-effect";
import { cancelJob } from "@/lib/actions";
import { ERROR_CODE } from "@/lib/constants";
import {
  convertBase64AudioToOgg,
  convertMediaToOgg,
  reduceBackgroundNoise,
} from "@/lib/ffmpeg-client";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  SparkleIcon,
  SpinnerIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useQueryState } from "nuqs";
import { useEffect, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";
import { getTTSJobStatus, runTTSJob } from "../actions";
import { RunPodTTSJob, TTSFormSchema } from "../lib/schema";
import { ReferenceAudioUpload } from "./reference-audio-upload";
import { ReferenceTranscription } from "./reference-transcription";
import { TextInput } from "./text-input";

export interface TTSFormProps {
  job: z.output<typeof RunPodTTSJob> | null;
}

export function TTSForm({ job }: TTSFormProps) {
  const [jobId, setJobId] = useQueryState("jobId");
  const [jobStatus, setJobStatus] = useState<string | null>(
    job?.status ?? null,
  );
  const [outputAudioUrl, setOutputAudioUrl] = useState<string | null>(null);
  const [isCancelling, startCancelTransition] = useTransition();

  const isPending = jobStatus === "IN_QUEUE" || jobStatus === "IN_PROGRESS";

  const {
    control,
    setError,
    clearErrors,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(TTSFormSchema),
  });

  const cancelTTSJob = async () => {
    if (!jobId || !isPending) return;

    const targetJobId = jobId;

    clearErrors();
    await setJobId(null);
    setJobStatus(null);

    const res = await cancelJob(targetJobId);

    if (res.success) {
      toast("Job has been cancelled");
    } else {
      if (res.error !== ERROR_CODE.UNKNOWN) {
        toast.error(res.error);
      }
    }
  };

  const onSubmit = handleSubmit(async (data) => {
    if (jobId && isPending) void cancelJob(jobId).catch(() => void 0);

    setJobStatus(null);

    const processedFile = await reduceBackgroundNoise(data.file).andThen(
      convertMediaToOgg,
    );

    const formData = new FormData();
    formData.append("text", data.text);
    formData.append(
      "file",
      processedFile.isOk() ? processedFile.value : data.file,
    );
    formData.append("referenceText", data.referenceText);

    const result = await runTTSJob(formData);

    if (!result.success) {
      return setError("root", { message: result.error });
    }

    await setJobId(result.data.id);
    setJobStatus(result.data.status);
  });

  const handleJobResponse = async (job: z.output<typeof RunPodTTSJob>) => {
    setJobStatus(job.status);

    switch (job.status) {
      case "FAILED":
        return setError("root", {
          message:
            "Encountered an error while generating audio. Ensure you are using a safe reference audio, or change the reference audio",
        });
      case "TIMED_OUT":
        return setError("root", {
          message:
            "Audio generation timed out, reduce the text length to generate a shorter audio",
        });
      case "COMPLETED":
        const file = await convertBase64AudioToOgg(
          job.output.audio,
          job.output.format,
        );

        if (file.isErr()) {
          setJobStatus("FAILED");
          return setError("root", {
            message: "Encountered an error while processing audio output",
          });
        }

        setOutputAudioUrl((prevUrl) => {
          if (prevUrl) URL.revokeObjectURL(prevUrl);
          return URL.createObjectURL(file.value);
        });
    }
  };

  useEffect(() => {
    if (!job) return;
    void handleJobResponse(job);
  }, [job]);

  usePollEffect(
    async () => {
      const res = await getTTSJobStatus(jobId!);

      if (!res.success) {
        setJobStatus("FAILED");
        return setError("root", { message: res.error });
      }

      await handleJobResponse(res.data);
    },
    isPending ? 10000 : null,
  );

  return (
    <form className="border-border bg-card space-y-6 border p-6 lg:col-span-7">
      {errors.root?.message && (
        <div className="flex items-center gap-2 border border-red-300 bg-red-50 p-3 text-xs text-red-800">
          <WarningCircleIcon
            className="mt-0.5 shrink-0 text-red-600"
            size={16}
          />
          <div className="flex-1">
            <span className="font-bold">Error:</span> {errors.root.message}
          </div>
        </div>
      )}

      <ReferenceAudioUpload
        control={control}
        disabled={isSubmitting || isPending}
      />
      <ReferenceTranscription
        control={control}
        disabled={isSubmitting || isPending}
      />
      <TextInput control={control} disabled={isSubmitting || isPending} />

      {outputAudioUrl && (
        <div className="border-border flex flex-col gap-1 border-t py-2">
          <span className="text-muted-foreground font-mono text-[9px] font-bold uppercase">
            Output Preview:
          </span>
          <audio src={outputAudioUrl} controls className="h-8 w-full text-xs" />
        </div>
      )}

      <div className="border-border flex flex-col gap-4 border-t pt-4 sm:flex-row sm:justify-start">
        <Button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting || isPending}
          variant={isSubmitting || isPending ? "ghost" : "default"}
        >
          {isSubmitting || isPending ? (
            <>
              <SpinnerIcon className="animate-spin" />
              {isPending ? "Generating..." : "Initiating Job..."}
            </>
          ) : (
            <>
              <SparkleIcon />
              Generate Speech
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!jobId || !isPending || isCancelling}
          onClick={() => {
            startCancelTransition(cancelTTSJob);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
