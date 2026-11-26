"use client";

import { CameraIcon, CheckIcon, TrashIcon, UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";

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
import { captureWebcamSnapshot } from "@/lib/media/devices";
import { cn } from "@/lib/utils";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface PhotoPickerProps {
  assets: MediaAsset[];
  selectedAssetId: string;
  onSelect: (assetId: string) => void;
  onUpload: (file: File) => Promise<void> | void;
  onClear?: () => void;
  onCaptureWebcam?: () => Promise<void> | void;
  enableWebcamModal?: boolean;
  onDeleteAsset?: (asset: MediaAsset) => Promise<void> | void;
  protectedAssetIds?: ReadonlySet<string>;
  isBusy?: boolean;
  showClear?: boolean;
}

export function PhotoPicker({
  assets,
  selectedAssetId,
  onSelect,
  onUpload,
  onClear,
  onCaptureWebcam,
  enableWebcamModal = false,
  onDeleteAsset,
  protectedAssetIds,
  isBusy = false,
  showClear = false,
}: PhotoPickerProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);

  const [localError, setLocalError] = useState<string | null>(null);
  const [assetToDelete, setAssetToDelete] = useState<MediaAsset | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [webcamOpen, setWebcamOpen] = useState(false);
  const [webcamError, setWebcamError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  function stopWebcamStream() {
    if (webcamStreamRef.current) {
      for (const track of webcamStreamRef.current.getTracks()) {
        track.stop();
      }
      webcamStreamRef.current = null;
    }
  }

  useEffect(() => {
    if (!enableWebcamModal || !webcamOpen) {
      stopWebcamStream();
      return;
    }

    let cancelled = false;
    setWebcamError(null);

    async function startWebcam() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        webcamStreamRef.current = stream;
        if (webcamVideoRef.current) {
          webcamVideoRef.current.srcObject = stream;
          await webcamVideoRef.current.play().catch(() => {});
        }
      } catch (err) {
        if (!cancelled) {
          setWebcamError(
            formatFriendlyError(err, "Could not access your camera. Check browser permissions."),
          );
        }
      }
    }

    void startWebcam();

    return () => {
      cancelled = true;
      stopWebcamStream();
    };
  }, [enableWebcamModal, webcamOpen]);

  function attachWebcamVideo(el: HTMLVideoElement | null) {
    webcamVideoRef.current = el;
    if (el && webcamStreamRef.current && el.srcObject !== webcamStreamRef.current) {
      el.srcObject = webcamStreamRef.current;
      void el.play().catch(() => {});
    }
  }

  async function handleFileSelected(file: File) {
    setLocalError(null);
    if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type)) {
      setLocalError("Please choose a JPG, PNG, or WebP photo.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setLocalError("That photo is too large. Please choose one under 15 MB.");
      return;
    }
    try {
      await onUpload(file);
    } catch (err) {
      setLocalError(formatFriendlyError(err, "Could not upload that photo. Please try again."));
    }
  }

  function openWebcamModal() {
    setWebcamError(null);
    setWebcamOpen(true);
  }

  function closeWebcamModal() {
    stopWebcamStream();
    setWebcamOpen(false);
  }

  async function handleTakeModalPhoto() {
    if (!webcamVideoRef.current) return;
    setWebcamError(null);
    setIsCapturing(true);
    try {
      const file = await captureWebcamSnapshot(webcamVideoRef.current);
      closeWebcamModal();
      await onUpload(file);
    } catch (err) {
      setWebcamError(formatFriendlyError(err, "Could not take photo. Please try again."));
    } finally {
      setIsCapturing(false);
    }
  }

  async function handleConfirmDelete() {
    if (!assetToDelete || !onDeleteAsset) return;
    setLocalError(null);
    setIsDeleting(true);
    try {
      await onDeleteAsset(assetToDelete);
      setAssetToDelete(null);
    } catch (err) {
      setLocalError(formatFriendlyError(err, "Could not remove that photo. Please try again."));
    } finally {
      setIsDeleting(false);
    }
  }

  const canTakePhoto = Boolean(onCaptureWebcam || enableWebcamModal);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId}>Target photo</Label>
        {onClear && (selectedAssetId || showClear) ? (
          <Button type="button" variant="ghost" size="xs" disabled={isBusy} onClick={onClear}>
            <XIcon data-icon="inline-start" />
            Clear
          </Button>
        ) : null}
      </div>

      {assets.length > 0 ? (
        <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto pr-0.5">
          {assets.map((asset) => {
            const isSelected = asset.id === selectedAssetId;
            return (
              <div key={asset.id} className="group relative">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`Select photo ${asset.name}`}
                  disabled={isBusy}
                  onClick={() => onSelect(asset.id)}
                  className={cn(
                    "relative block aspect-[4/3] w-full overflow-hidden rounded-md border bg-surface transition-all focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
                    isSelected
                      ? "border-primary ring-2 ring-primary/25"
                      : "border-border hover:border-primary/50",
                  )}
                >
                  <img
                    src={asset.downloadUrl}
                    alt={asset.name}
                    className="h-full w-full object-cover"
                  />
                  {isSelected ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-1.5 left-1.5 inline-flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs"
                    >
                      <CheckIcon className="size-3" weight="bold" />
                    </span>
                  ) : null}
                </button>

                {onDeleteAsset && !protectedAssetIds?.has(asset.id) ? (
                  <button
                    type="button"
                    aria-label={`Delete ${asset.name} permanently`}
                    disabled={isBusy}
                    onClick={() => setAssetToDelete(asset)}
                    className="absolute top-1.5 right-1.5 inline-flex size-7 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground opacity-90 shadow-xs transition-opacity hover:text-destructive-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface p-4 text-center text-xs text-muted-foreground">
          No saved photos yet. Upload a photo or snap one with your camera.
        </div>
      )}

      <input
        ref={fileInputRef}
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFileSelected(file);
          e.target.value = "";
        }}
      />

      <div className={cn("grid gap-2", canTakePhoto ? "grid-cols-2" : "grid-cols-1")}>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={isBusy}
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadSimpleIcon data-icon="inline-start" />
          Upload photo
        </Button>

        {canTakePhoto ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={isBusy}
            onClick={() => {
              if (onCaptureWebcam) {
                void onCaptureWebcam();
              } else if (enableWebcamModal) {
                void openWebcamModal();
              }
            }}
          >
            <CameraIcon data-icon="inline-start" />
            Take photo
          </Button>
        ) : null}
      </div>

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
            <DialogTitle>Delete photo permanently?</DialogTitle>
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

      {/* Webcam capture modal (used when no stage webcam preview is active) */}
      {enableWebcamModal ? (
        <Dialog open={webcamOpen} onOpenChange={(open) => !open && closeWebcamModal()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Take a photo</DialogTitle>
              <DialogDescription>
                Center yourself in the frame and capture a look photo.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 overflow-hidden rounded-md border border-border bg-background">
              <video
                ref={attachWebcamVideo}
                muted
                playsInline
                autoPlay
                className="aspect-video w-full object-cover"
              />
            </div>
            {webcamError ? (
              <Alert variant="destructive" className="mt-3">
                <AlertDescription>{webcamError}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isCapturing}
                onClick={closeWebcamModal}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={isCapturing || Boolean(webcamError)}
                onClick={() => void handleTakeModalPhoto()}
              >
                {isCapturing ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <CameraIcon data-icon="inline-start" />
                )}
                Use photo
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
