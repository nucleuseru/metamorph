"use client";

import {
  CheckCircleIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
  UploadSimpleIcon,
  WaveformIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";

import { AudioRecorderInline } from "@/components/media/audio-recorder-inline";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { MediaAsset } from "@/lib/api-client";
import { formatFriendlyError } from "@/lib/creator-copy";
import { cn } from "@/lib/utils";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/flac",
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
]);

interface VoicePickerProps {
  assets: MediaAsset[];
  selectedAssetId: string;
  selectedMicId?: string;
  onSelect: (assetId: string) => void;
  onUpload: (file: File) => Promise<void> | void;
  onClear?: () => void;
  onDeleteAsset?: (asset: MediaAsset) => Promise<void> | void;
  protectedAssetIds?: ReadonlySet<string>;
  isBusy?: boolean;
}

export function VoicePicker({
  assets,
  selectedAssetId,
  selectedMicId,
  onSelect,
  onUpload,
  onClear,
  onDeleteAsset,
  protectedAssetIds,
  isBusy = false,
}: VoicePickerProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);

  const [playingAssetId, setPlayingAssetId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [assetToDelete, setAssetToDelete] = useState<MediaAsset | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    return () => {
      audioCleanupRef.current?.();
      audioCleanupRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
        audioRef.current = null;
      }
    };
  }, []);

  function stopPreview() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlayingAssetId(null);
  }

  function handleTogglePreview(asset: MediaAsset) {
    setLocalError(null);
    if (playingAssetId === asset.id) {
      stopPreview();
      return;
    }

    if (!audioRef.current) {
      const el = new Audio();
      const onEnded = () => setPlayingAssetId(null);
      const onError = () => {
        if (!el.getAttribute("src")) return;
        setPlayingAssetId(null);
        setLocalError("Could not play that voice clip.");
      };
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);
      audioCleanupRef.current = () => {
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
      };
      audioRef.current = el;
    }

    audioRef.current.pause();
    audioRef.current.src = asset.downloadUrl;
    setPlayingAssetId(asset.id);
    void audioRef.current.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setPlayingAssetId(null);
      setLocalError("Could not play that voice clip.");
    });
  }

  async function handleFileSelected(file: File) {
    setLocalError(null);
    if (file.type && !ALLOWED_AUDIO_TYPES.has(file.type)) {
      setLocalError("Please choose an MP3, WAV, M4A, OGG, FLAC, or WebM audio clip.");
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      setLocalError("That voice clip is too large. Please choose a clip under 25 MB.");
      return;
    }
    try {
      await onUpload(file);
    } catch (err) {
      setLocalError(
        formatFriendlyError(err, "Could not upload that voice clip. Please try again."),
      );
    }
  }

  async function handleConfirmDelete() {
    if (!assetToDelete || !onDeleteAsset) return;
    setLocalError(null);
    setIsDeleting(true);
    try {
      if (playingAssetId === assetToDelete.id) {
        stopPreview();
      }
      await onDeleteAsset(assetToDelete);
      setAssetToDelete(null);
    } catch (err) {
      setLocalError(
        formatFriendlyError(err, "Could not remove that voice clip. Please try again."),
      );
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId}>Target voice</Label>
        {onClear && selectedAssetId ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={isBusy}
            onClick={() => {
              if (playingAssetId === selectedAssetId) {
                stopPreview();
              }
              onClear();
            }}
          >
            <XIcon data-icon="inline-start" />
            Clear
          </Button>
        ) : null}
      </div>

      {assets.length > 0 ? (
        <div className="flex max-h-52 flex-col gap-2 overflow-y-auto pr-0.5">
          {assets.map((asset) => {
            const isSelected = asset.id === selectedAssetId;
            const isPlaying = playingAssetId === asset.id;
            return (
              <div
                key={asset.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
                  isSelected
                    ? "border-primary bg-accent-soft/60"
                    : "border-border bg-background hover:bg-surface",
                )}
              >
                <button
                  type="button"
                  aria-pressed={isSelected}
                  disabled={isBusy}
                  onClick={() => onSelect(asset.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  {isSelected ? (
                    <CheckCircleIcon className="size-4 shrink-0 text-primary" weight="fill" />
                  ) : (
                    <WaveformIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-xs font-medium text-foreground">{asset.name}</span>
                </button>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={isPlaying ? `Pause ${asset.name}` : `Play ${asset.name}`}
                  onClick={() => handleTogglePreview(asset)}
                >
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </Button>

                {onDeleteAsset && !protectedAssetIds?.has(asset.id) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${asset.name} permanently`}
                    disabled={isBusy}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setAssetToDelete(asset)}
                  >
                    <TrashIcon />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface p-4 text-center text-xs text-muted-foreground">
          No saved voice clips yet. Upload an audio clip or record your voice below.
        </div>
      )}

      <input
        ref={fileInputRef}
        id={inputId}
        type="file"
        accept="audio/wav,audio/mpeg,audio/flac,audio/ogg,audio/mp4,audio/webm"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFileSelected(file);
          e.target.value = "";
        }}
      />

      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={isBusy}
        onClick={() => fileInputRef.current?.click()}
      >
        <UploadSimpleIcon data-icon="inline-start" />
        Upload audio
      </Button>

      <AudioRecorderInline
        deviceId={selectedMicId || undefined}
        isBusy={isBusy}
        label="Record voice"
        onRecorded={onUpload}
      />

      {localError ? (
        <Alert variant="destructive">
          <AlertDescription>{localError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Delete confirmation dialog */}
      <Dialog
        open={Boolean(assetToDelete)}
        onOpenChange={(open) => !open && !isDeleting && setAssetToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete voice clip permanently?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="font-medium text-foreground">{assetToDelete?.name}</span> from your
              library. You won&apos;t be able to undo this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              disabled={isDeleting}
              onClick={() => setAssetToDelete(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeleting}
              onClick={() => void handleConfirmDelete()}
            >
              {isDeleting ? <Spinner data-icon="inline-start" /> : null}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
