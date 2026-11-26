"use client";

import { MicrophoneIcon, StopIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatFriendlyError } from "@/lib/creator-copy";
import { AudioClipRecorder } from "@/lib/media/devices";

interface AudioRecorderInlineProps {
  deviceId?: string;
  onRecorded: (file: File) => Promise<void> | void;
  isBusy?: boolean;
  label?: string;
}

export function AudioRecorderInline({
  deviceId,
  onRecorded,
  isBusy = false,
  label = "Record voice",
}: AudioRecorderInlineProps) {
  const recorderRef = useRef<AudioClipRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function startRecording() {
    setError(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setPreviewFile(null);
    setDurationMs(0);

    const recorder = new AudioClipRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start(deviceId, {
        onLevel: setLevel,
        onDurationMs: setDurationMs,
      });
      setRecording(true);
    } catch (err) {
      setError(
        formatFriendlyError(
          err,
          "Could not start microphone recording. Check your mic permissions.",
        ),
      );
      recorderRef.current = null;
    }
  }

  async function stopRecording() {
    if (!recorderRef.current) return;
    try {
      const file = await recorderRef.current.stop();
      recorderRef.current = null;
      setRecording(false);
      setLevel(0);
      setPreviewFile(file);
      setPreviewUrl(URL.createObjectURL(file));
    } catch (err) {
      setError(formatFriendlyError(err, "Could not finish recording. Please try again."));
      setRecording(false);
    }
  }

  async function handleSave() {
    if (!previewFile) return;
    setError(null);
    try {
      await onRecorded(previewFile);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setPreviewFile(null);
    } catch (err) {
      setError(formatFriendlyError(err, "Could not save your voice clip. Please try again."));
    }
  }

  function discardPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewFile(null);
    setDurationMs(0);
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
      {!recording && !previewFile ? (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isBusy}
            onClick={() => void startRecording()}
          >
            <MicrophoneIcon data-icon="inline-start" />
            {label}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Speak clearly for 5–15 seconds
          </p>
        </div>
      ) : null}

      {recording ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-1 items-center gap-2.5">
              <span className="size-2.5 animate-pulse rounded-full bg-destructive" />
              <span className="font-mono text-xs text-foreground tabular-nums">
                {(durationMs / 1000).toFixed(1)}s
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-tertiary">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-75"
                  style={{ width: `${Math.round(level * 100)}%` }}
                />
              </div>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="xs"
              onClick={() => void stopRecording()}
            >
              <StopIcon data-icon="inline-start" />
              Stop
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Speak clearly for 5–15 seconds</p>
        </div>
      ) : null}

      {previewFile && previewUrl ? (
        <div className="flex flex-col gap-2">
          <audio src={previewUrl} controls className="h-9 w-full" />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              className="flex-1"
              disabled={isBusy}
              onClick={() => void handleSave()}
            >
              {isBusy ? <Spinner data-icon="inline-start" /> : null}
              Save voice clip
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Discard recording"
              disabled={isBusy}
              onClick={discardPreview}
            >
              <TrashIcon />
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
