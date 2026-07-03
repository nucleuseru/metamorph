"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useIntervalEffect } from "@/hooks/use-interval-effect";
import { cancelJob } from "@/lib/actions";
import { cn, getFFmpeg } from "@/lib/utils";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  FileAudioIcon,
  HourglassIcon,
  SparkleIcon,
  SpinnerIcon,
  StopIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { parseAsInteger, useQueryState } from "nuqs";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { getTTSJobStatus, runTTSJob } from "../lib/actions";
import { TEXT_MAX_LENGTH, TTSFormSchema } from "../lib/schema";

const pendingStatuses = ["IN_QUEUE", "IN_PROGRESS", "RUNNING"];

export function TTSForm() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  // States persisted in URL using nuqs
  const [jobId, setJobId] = useQueryState("jobId");
  const [text, setText] = useQueryState("text", { defaultValue: "" });
  const [referenceText, setReferenceText] = useQueryState("referenceText", {
    defaultValue: "",
  });
  const [jobStartTimestamp, setJobStartTimestamp] = useQueryState(
    "jobStartTimestamp",
    parseAsInteger,
  );

  // UI state
  const [jobStatus, setJobStatus] = useState<string>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Reference Audio local preview
  const [refAudioUrl, setRefAudioUrl] = useState<string>();

  // Generated Raw Audio Data from server
  const [rawAudioData, setRawAudioData] = useState<{
    audio: string;
    format: string;
  } | null>(null);

  // Converted Audio (Opus/Ogg) state
  const [convertedAudioUrl, setConvertedAudioUrl] = useState<string | null>(
    null,
  );
  const [conversionStatus, setConversionStatus] = useState<
    "idle" | "loading" | "converting" | "ready" | "error"
  >("idle");

  const {
    control,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isLoading: isSubmitting },
  } = useForm({
    resolver: zodResolver(TTSFormSchema),
    defaultValues: {
      text,
      referenceText,
    },
  });

  // Clean up URL objects on unmount
  useEffect(() => {
    return () => {
      if (refAudioUrl) URL.revokeObjectURL(refAudioUrl);
      if (convertedAudioUrl) URL.revokeObjectURL(convertedAudioUrl);
    };
  }, [refAudioUrl, convertedAudioUrl]);

  // Timer for elapsed seconds while synthesis job is pending
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (jobId && (!jobStatus || pendingStatuses.includes(jobStatus))) {
      const startTime = jobStartTimestamp || Date.now();

      if (!jobStartTimestamp) {
        void setJobStartTimestamp(startTime);
      }

      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));

      interval = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } else {
      setElapsedSeconds(0);
      if (jobStartTimestamp) {
        void setJobStartTimestamp(null);
      }
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [jobId, jobStatus, jobStartTimestamp]);

  const convertAudio = async (base64Audio: string, inputFormat: string) => {
    setConversionStatus("loading");

    try {
      const ffmpeg = await getFFmpeg();
      ffmpegRef.current = ffmpeg;
      setConversionStatus("converting");

      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const inputName = `input.${inputFormat}`;
      const outputName = "output.ogg";

      await ffmpeg.writeFile(inputName, bytes);

      await ffmpeg.exec([
        "-i",
        inputName,
        "-b:a",
        "128k",
        "-c:a",
        "libopus",
        outputName,
      ]);

      const data = await ffmpeg.readFile(outputName);
      const convertedBlob = new Blob([data as any], {
        type: "audio/ogg; codecs=opus",
      });
      const url = URL.createObjectURL(convertedBlob);

      setConvertedAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setConversionStatus("ready");

      try {
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
      } catch {
        void 0;
      }
    } catch (err: any) {
      console.error("FFmpeg conversion error:", err);
      setConversionStatus("error");
      setError("root", {
        message: `Audio conversion failed: ${err.message || err}`,
      });
    }
  };

  // Cancel currently running TTS Job
  const cancelTTSJob = async () => {
    if (!jobId) return;

    const targetJobId = jobId;

    // Clear status and URL query params
    setJobId(null);
    setJobStatus(undefined);
    setRawAudioData(null);
    setConvertedAudioUrl(null);
    setConversionStatus("idle");
    void setJobStartTimestamp(null);
    clearErrors();

    // Trigger cancel api
    await cancelJob(targetJobId);
  };

  // Submit new TTS generation job
  const onSubmit = handleSubmit(async (data) => {
    clearErrors();

    // IF a new job is started while a previous one is running, cancel the previous job
    if (jobId && (!jobStatus || pendingStatuses.includes(jobStatus))) {
      void cancelJob(jobId);
    }

    // Reset output states for the new job
    setRawAudioData(null);
    setConvertedAudioUrl(null);
    setConversionStatus("idle");
    setJobStatus(undefined);

    const formData = new FormData();
    formData.append("text", data.text);
    formData.append("file", data.file);
    formData.append("referenceText", data.referenceText);

    const result = await runTTSJob(formData);

    if (!result.success) {
      return setError("root", { message: result.error });
    }

    await setJobStartTimestamp(Date.now());
    await setJobId(result.data.id);
    setJobStatus(result.data.status);
  });

  // Polling logic
  const pollJobStatus = useEffectEvent(async () => {
    if (!jobId) return;

    // Only poll when status is undefined or pending
    if (jobStatus && !pendingStatuses.includes(jobStatus)) return;

    const result = await getTTSJobStatus(jobId);

    if (!result.success) {
      // If we don't have a status yet, job might not have propagated, reset jobId.
      // Otherwise, show error.
      if (!jobStatus) {
        setJobId(null);
      } else {
        setError("root", { message: result.error });
      }
      return;
    }

    const job = result.data;
    setJobStatus(job.status);

    if (job.status === "COMPLETED") {
      setRawAudioData({
        audio: job.output.audio,
        format: job.output.format,
      });

      // Run FFmpeg conversion to Opus/Ogg format
      if (!convertedAudioUrl) {
        void convertAudio(job.output.audio, job.output.format);
      }
    } else if (job.status === "FAILED" || job.status === "TIMED_OUT") {
      setError("root", {
        message:
          (job as any).error || `Job terminated with status ${job.status}`,
      });
    }
  });

  // Fetch status on mount (survives refresh)
  useEffect(() => {
    if (jobId) {
      void pollJobStatus();
    }
  }, []);

  // Poll job status every 10 seconds, but ONLY when necessary
  const shouldPoll = !!(
    jobId &&
    (!jobStatus || pendingStatuses.includes(jobStatus))
  );
  useIntervalEffect(
    () => {
      void pollJobStatus();
    },
    shouldPoll ? 10000 : null,
  );

  const isPending = !!(
    jobId &&
    (!jobStatus || pendingStatuses.includes(jobStatus))
  );

  return (
    <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
      {/* LEFT COLUMN: Input Configuration Form */}
      <form
        onSubmit={onSubmit}
        className="space-y-6 border border-zinc-300 bg-white p-6 lg:col-span-7"
      >
        <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
          <h2 className="font-mono text-sm font-bold tracking-wider text-zinc-900 uppercase">
            TTS Synthesizer Settings
          </h2>
          <span className="font-mono text-[10px] text-zinc-400 uppercase">
            Input Config
          </span>
        </div>

        {/* Root form errors */}
        {errors.root?.message && (
          <div className="flex items-start gap-2 border border-red-300 bg-red-50 p-3 font-mono text-xs text-red-800">
            <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div className="flex-1">
              <span className="font-bold">Error:</span> {errors.root.message}
            </div>
          </div>
        )}

        <div className="space-y-5">
          {/* Reference Audio File upload */}
          <Controller
            control={control}
            name="file"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="space-y-1.5">
                <FieldLabel
                  htmlFor="file"
                  className="font-mono text-xs font-bold text-zinc-800"
                >
                  Reference Voice Audio
                </FieldLabel>

                <input
                  type="file"
                  accept="audio/mpeg,audio/ogg,audio/wav,audio/webm"
                  className="hidden"
                  ref={fileInputRef}
                  name={field.name}
                  onBlur={field.onBlur}
                  disabled={field.disabled || isSubmitting || isPending}
                  onChange={(e) => {
                    const file = e.currentTarget.files?.item(0);
                    field.onChange(file);

                    if (file) {
                      const url = URL.createObjectURL(file);
                      setRefAudioUrl((prev) => {
                        if (prev) URL.revokeObjectURL(prev);
                        return url;
                      });
                    }
                  }}
                />

                {!field.value ? (
                  <div
                    onClick={() =>
                      !isSubmitting &&
                      !isPending &&
                      fileInputRef.current?.click()
                    }
                    className={cn(
                      "flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center transition duration-200 hover:border-black hover:bg-zinc-50",
                      (isSubmitting || isPending) &&
                        "cursor-not-allowed opacity-50",
                    )}
                  >
                    <UploadSimpleIcon className="h-6 w-6 text-zinc-400" />
                    <span className="text-xs font-semibold text-zinc-700">
                      Click to upload voice reference
                    </span>
                    <span className="font-mono text-[10px] text-zinc-400">
                      Accepts MP3, WAV, OGG, WEBM
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 border border-zinc-300 bg-white p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="border border-zinc-200 bg-zinc-100 p-2">
                          <FileAudioIcon className="h-5 w-5 text-zinc-600" />
                        </div>
                        <div className="flex flex-col">
                          <span className="max-w-[240px] truncate font-mono text-xs font-bold text-zinc-800">
                            {(field.value as File).name}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-400">
                            {(
                              (field.value as File).size /
                              (1024 * 1024)
                            ).toFixed(2)}{" "}
                            MB • {(field.value as File).type}
                          </span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto rounded-none border border-transparent px-2 py-1 font-mono text-xs text-zinc-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                        onClick={() => {
                          field.onChange(undefined);
                          setRefAudioUrl((prev) => {
                            if (prev) URL.revokeObjectURL(prev);
                            return undefined;
                          });
                          if (fileInputRef.current)
                            fileInputRef.current.value = "";
                        }}
                        disabled={isSubmitting || isPending}
                      >
                        Remove
                      </Button>
                    </div>
                    {refAudioUrl && (
                      <div className="flex flex-col gap-1 border-t border-zinc-100 pt-2">
                        <span className="font-mono text-[9px] font-bold text-zinc-400 uppercase">
                          Source Voice Preview:
                        </span>
                        <audio
                          src={refAudioUrl}
                          controls
                          className="h-8 w-full border border-zinc-200 bg-zinc-50 font-mono text-xs"
                        />
                      </div>
                    )}
                  </div>
                )}

                <FieldDescription className="font-mono text-[10px] text-zinc-400">
                  Provide an audio sample of the voice structure to
                  clone.
                </FieldDescription>
                {fieldState.invalid && (
                  <FieldError
                    errors={[fieldState.error]}
                    className="font-mono text-xs text-red-600"
                  />
                )}
              </Field>
            )}
          />

          {/* Reference Text (Transcription) */}
          <Controller
            control={control}
            name="referenceText"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="space-y-1.5">
                <FieldLabel
                  htmlFor="referenceText"
                  className="font-mono text-xs font-bold text-zinc-800"
                >
                  Reference Transcription
                </FieldLabel>
                <Textarea
                  {...field}
                  aria-invalid={fieldState.invalid}
                  disabled={isSubmitting || isPending}
                  className="min-h-[60px] resize-none rounded-none border-zinc-300 bg-white p-2.5 font-mono text-xs shadow-none focus-visible:border-black focus-visible:ring-0"
                  placeholder="Enter the exact text spoken in the reference audio sample..."
                  onChange={(e) => {
                    void setReferenceText(e.currentTarget.value);
                    field.onChange(e);
                  }}
                />
                <FieldDescription className="font-mono text-[10px] text-zinc-400">
                  This text matches the reference audio file, calibrating voice
                  tone mapping.
                </FieldDescription>
                {fieldState.invalid && (
                  <FieldError
                    errors={[fieldState.error]}
                    className="font-mono text-xs text-red-600"
                  />
                )}
              </Field>
            )}
          />

          {/* Text to Synthesize */}
          <Controller
            control={control}
            name="text"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <FieldLabel
                    htmlFor="text"
                    className="font-mono text-xs font-bold text-zinc-800"
                  >
                    Speech Script
                  </FieldLabel>
                  <span
                    className={cn(
                      "font-mono text-[10px]",
                      (field.value?.length || 0) > TEXT_MAX_LENGTH
                        ? "font-bold text-red-500"
                        : "text-zinc-400",
                    )}
                  >
                    {field.value?.length || 0} / {TEXT_MAX_LENGTH} chars
                  </span>
                </div>
                <Textarea
                  {...field}
                  aria-invalid={fieldState.invalid}
                  disabled={isSubmitting || isPending}
                  className="min-h-[70px] resize-none rounded-none border-zinc-300 bg-white p-2.5 font-mono text-xs shadow-none focus-visible:border-black focus-visible:ring-0"
                  placeholder="Enter the script you want synthesized into speech..."
                  onChange={(e) => {
                    void setText(e.currentTarget.value);
                    field.onChange(e);
                  }}
                />
                <FieldDescription className="font-mono text-[10px] text-zinc-400">
                  The script that will be synthetically read by the cloned voice
                  model.
                </FieldDescription>
                {fieldState.invalid && (
                  <FieldError
                    errors={[fieldState.error]}
                    className="font-mono text-xs text-red-600"
                  />
                )}
              </Field>
            )}
          />
        </div>

        <div className="border-t border-zinc-200 pt-4">
          <Button
            type="submit"
            disabled={isSubmitting || isPending}
            className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-none border border-black bg-black py-2.5 font-mono text-xs font-bold tracking-wider text-white uppercase transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-400"
          >
            {isSubmitting || isPending ? (
              <>
                <SpinnerIcon className="h-4 w-4 animate-spin" />
                {isPending
                  ? `Generating (${elapsedSeconds}s)`
                  : "Initiating Job..."}
              </>
            ) : (
              <>
                <SparkleIcon className="h-4 w-4" />
                Generate Speech
              </>
            )}
          </Button>
        </div>
      </form>

      {/* RIGHT COLUMN: Active Job & Output State */}
      <div className="space-y-6 lg:col-span-5">
        {/* State A: No Active Job */}
        {!jobId && (
          <div className="flex min-h-[360px] flex-col items-center justify-center gap-4 border border-dashed border-zinc-300 bg-white p-8 text-center">
            <div className="rounded-none border border-zinc-100 bg-zinc-50 p-4 text-zinc-400">
              <HourglassIcon className="h-8 w-8" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-xs font-bold tracking-wider text-zinc-700 uppercase">
                No Job Initialized
              </span>
              <p className="mx-auto max-w-[220px] font-mono text-[10px] leading-relaxed text-zinc-400">
                Configure voice properties and enter your text script on the
                left, then click Generate Speech.
              </p>
            </div>
          </div>
        )}

        {/* State B: Job Pending / Active */}
        {jobId && isPending && (
          <div className="flex min-h-[360px] flex-col justify-between space-y-5 border border-zinc-300 bg-white p-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs font-bold tracking-wider text-zinc-900 uppercase">
                    Job Status
                  </span>
                  <span className="max-w-[160px] truncate font-mono text-[9px] text-zinc-400">
                    ID: {jobId}
                  </span>
                </div>
                <Badge className="animate-pulse rounded-none border border-yellow-200 bg-yellow-50 px-2 py-0.5 font-mono text-[9px] tracking-wider text-yellow-800 uppercase">
                  {jobStatus || "IN_QUEUE"}
                </Badge>
              </div>

              <div className="flex flex-col items-center justify-center gap-5 py-10">
                <div className="relative flex h-12 w-12 items-center justify-center">
                  <div className="absolute inset-0 rounded-full border-2 border-zinc-100"></div>
                  <div className="absolute inset-0 animate-spin rounded-full border-2 border-t-black"></div>
                  <HourglassIcon className="h-5 w-5 animate-pulse text-zinc-800" />
                </div>
                <div className="flex flex-col gap-1 text-center">
                  <span className="font-mono text-xs font-bold tracking-wide text-zinc-800 uppercase">
                    Processing Pipeline
                  </span>
                  <span className="font-mono text-[10px] text-zinc-500">
                    Elapsed duration: {elapsedSeconds}s
                  </span>
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={cancelTTSJob}
              className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-none border-zinc-300 py-2.5 font-mono text-xs text-red-600 uppercase hover:bg-zinc-50 hover:text-red-700"
            >
              <StopIcon className="h-4 w-4" />
              Cancel Generation
            </Button>
          </div>
        )}

        {/* State C: Job Terminal Completed */}
        {jobId && jobStatus === "COMPLETED" && (
          <div className="space-y-5 border border-zinc-300 bg-white p-6">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-xs font-bold tracking-wider text-zinc-900 uppercase">
                  Output Pipeline
                </span>
                <span className="max-w-[160px] truncate font-mono text-[9px] text-zinc-400">
                  ID: {jobId}
                </span>
              </div>
              <Badge className="rounded-none border border-green-200 bg-green-50 px-2 py-0.5 font-mono text-[9px] tracking-wider text-green-800 uppercase">
                SUCCESS
              </Badge>
            </div>

            {/* FFmpeg Loader & Conversion UI */}
            {conversionStatus === "loading" && (
              <div className="flex flex-col items-center justify-center gap-3 py-12">
                <SpinnerIcon className="h-6 w-6 animate-spin text-zinc-800" />
                <span className="font-mono text-[10px] tracking-wide text-zinc-500 uppercase">
                  Loading WebAssembly FFmpeg...
                </span>
              </div>
            )}

            {conversionStatus === "converting" && (
              <div className="flex flex-col items-center justify-center gap-3 py-12">
                <SpinnerIcon className="h-6 w-6 animate-spin text-zinc-800" />
                <span className="font-mono text-[10px] tracking-wide text-zinc-500 uppercase">
                  Converting to Opus/Ogg (128kbps)...
                </span>
              </div>
            )}

            {conversionStatus === "error" && (
              <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                <WarningCircleIcon className="h-8 w-8 text-red-500" />
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-xs font-bold text-zinc-800 uppercase">
                    Conversion Failed
                  </span>
                  <span className="max-w-[200px] font-mono text-[10px] text-zinc-400">
                    Failed to convert raw audio using FFmpeg wasm.
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    rawAudioData &&
                    convertAudio(rawAudioData.audio, rawAudioData.format)
                  }
                  className="mt-2 cursor-pointer rounded-none border-zinc-300 px-3 py-1.5 font-mono text-xs font-bold uppercase"
                >
                  Retry Conversion
                </Button>
              </div>
            )}

            {conversionStatus === "ready" && convertedAudioUrl && (
              <div className="space-y-5 py-1">
                <div className="flex flex-col gap-2 border border-zinc-200 bg-zinc-50 p-4">
                  <div className="flex items-center gap-1.5 text-zinc-700">
                    <CheckCircleIcon className="h-4 w-4 text-green-600" />
                    <span className="font-mono text-xs font-bold tracking-wide uppercase">
                      Opus/Ogg Audio Output
                    </span>
                  </div>
                  <audio
                    src={convertedAudioUrl}
                    controls
                    className="h-9 w-full rounded-none border border-zinc-200 bg-white font-mono text-xs"
                  />
                  <div className="flex items-center justify-between font-mono text-[9px] text-zinc-400 uppercase">
                    <span>Format: OGG/OPUS</span>
                    <span>Bitrate: 128kbps</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <a
                    href={convertedAudioUrl}
                    download={`speech-${jobId}.ogg`}
                    className="flex w-full cursor-pointer items-center justify-center gap-2 border border-black bg-black py-2.5 text-center font-mono text-xs font-bold text-white uppercase transition hover:bg-zinc-800"
                  >
                    <DownloadSimpleIcon className="h-4 w-4" />
                    Download Opus Audio
                  </a>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setJobId(null);
                      setJobStatus(undefined);
                      setRawAudioData(null);
                      setConvertedAudioUrl(null);
                      setConversionStatus("idle");
                      clearErrors();
                    }}
                    className="w-full cursor-pointer rounded-none border-zinc-300 py-2.5 font-mono text-xs font-bold uppercase hover:bg-zinc-50"
                  >
                    Generate Another Speech
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* State D: Job Failed / Cancelled / Timed Out */}
        {jobId &&
          jobStatus &&
          !pendingStatuses.includes(jobStatus) &&
          jobStatus !== "COMPLETED" && (
            <div className="flex min-h-[360px] flex-col justify-between space-y-5 border border-zinc-300 bg-white p-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs font-bold tracking-wider text-zinc-900 uppercase">
                      Job Status
                    </span>
                    <span className="max-w-[160px] truncate font-mono text-[9px] text-zinc-400">
                      ID: {jobId}
                    </span>
                  </div>
                  <Badge className="rounded-none border border-red-200 bg-red-50 px-2 py-0.5 font-mono text-[9px] tracking-wider text-red-800 uppercase">
                    {jobStatus}
                  </Badge>
                </div>

                <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
                  <XCircleIcon className="h-10 w-10 text-red-500" />
                  <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-xs font-bold text-red-700 uppercase">
                      Synthesis Aborted
                    </span>
                    <p className="mx-auto max-w-[220px] font-mono text-[10px] leading-relaxed text-zinc-400">
                      {jobStatus === "CANCELLED"
                        ? "The generation was cancelled by the user and terminated on the remote server."
                        : "The request failed, timed out, or encountered a system fault on the processing server."}
                    </p>
                  </div>
                </div>
              </div>

              <Button
                type="button"
                onClick={() => {
                  setJobId(null);
                  setJobStatus(undefined);
                  setRawAudioData(null);
                  setConvertedAudioUrl(null);
                  setConversionStatus("idle");
                  clearErrors();
                }}
                className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-none border border-black bg-black py-2.5 font-mono text-xs font-bold text-white uppercase transition hover:bg-zinc-800"
              >
                <ArrowClockwiseIcon className="h-4 w-4" />
                Reset Synthesizer
              </Button>
            </div>
          )}
      </div>
    </div>
  );
}
