"use client";

import { cn } from "@/lib/utils";
import { UploadIcon } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Button } from "./ui/button";

export default function StreamForm() {
  const [error, setError] = useState("");
  const [sourceFace, setSourceFace] = useState<File>();
  const [isStreaming, setStreaming] = useState(false);
  const [isAudioVideoEnabled, setAudioVideoEnabled] = useState(false);

  const handleStart = useCallback(async () => {
    if (!sourceFace) {
      setError("Select a source face to start streaming");
      return;
    }

    if (!isAudioVideoEnabled) {
      setError("Enable audio and video to start streaming");
      return;
    }

    const formData = new FormData();
    formData.append("source-face", sourceFace);

    setError("");
    setStreaming(true);
  }, [sourceFace, isAudioVideoEnabled]);

  return (
    <div className="h-full flex flex-col-reverse gap-8 md:flex-row">
      <form className="space-y-8 w-80" action={handleStart}>
        <UploadImage disabled={isStreaming} onSelect={setSourceFace} />
        <p className="text-sm text-muted-foreground">
          Please upload a clear, well lit portrait of a face without expression,
          glasses, hats, or any accessories. Make sure the face is focused and
          perfectly illuminated.
        </p>

        {!!error && <div className="text-destructive text-sm">{error}</div>}

        <Button>Start streaming</Button>
      </form>

      <div>
        <UserMedia
          isAudioVideoEnabled={isAudioVideoEnabled}
          setAudioVideoEnabled={setAudioVideoEnabled}
        />
      </div>
    </div>
  );
}

function UserMedia({
  isAudioVideoEnabled,
  setAudioVideoEnabled,
}: {
  isAudioVideoEnabled: boolean;
  setAudioVideoEnabled: (value: boolean) => void;
}) {
  const [mediaStream, setMediaStream] = useState<MediaStream>();

  const videoRef = useRef<HTMLVideoElement>(null);

  const handleEnableAudioVideo = useCallback(async () => {
    if (!mediaStream) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1920, height: 1080 },
      audio: true,
    });

    mediaStream.getTracks().forEach((track) => {
      mediaStream.removeTrack(track);
    });

    stream.getTracks().forEach((track) => {
      mediaStream.addTrack(track);
    });

    setAudioVideoEnabled(true);
  }, [mediaStream, setAudioVideoEnabled]);

  useEffect(() => {
    if (videoRef.current) {
      const mediaStream = new MediaStream();
      videoRef.current.srcObject = mediaStream;
      setMediaStream(mediaStream);
    }
  }, []);

  return (
    <div
      className={
        !isAudioVideoEnabled
          ? "size-80 flex flex-col items-center justify-center rounded-xl border"
          : "h-full"
      }
    >
      <video
        muted
        autoPlay
        ref={videoRef}
        className={cn(
          "size-full object-cover rounded-xl border rotate-y-180",
          !isAudioVideoEnabled && "hidden"
        )}
      />

      {!isAudioVideoEnabled && (
        <Button variant="ghost" onClick={handleEnableAudioVideo}>
          Enable audio and video
        </Button>
      )}
    </div>
  );
}

function UploadImage({
  disabled,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: (file: File) => void;
}) {
  const {
    getRootProps,
    getInputProps,
    acceptedFiles,
    isDragAccept,
    isDragReject,
    isDragActive,
  } = useDropzone({
    maxFiles: 1,
    // minSize: 10 * 1024,
    // maxSize: 500 * 1024,
    autoFocus: true,
    disabled,
    accept: {
      "image/*": [],
    },
  });

  const imgUrl = useMemo(() => {
    if (acceptedFiles.length) {
      return URL.createObjectURL(acceptedFiles[0]);
    }
  }, [acceptedFiles]);

  useEffect(() => {
    if (acceptedFiles.length) {
      onSelect(acceptedFiles[0]);
    }
  }, [acceptedFiles, onSelect]);

  return (
    <div
      className="relative border rounded-xl size-80 overflow-hidden flex flex-col items-center justify-center focus:border-ring"
      {...getRootProps()}
    >
      <input {...getInputProps()} />

      <UploadIcon className="size-6 mb-6" />
      <div className="font-semibold mb-2">Upload source face</div>

      {isDragActive ? (
        <p className="text-center text-sm text-muted-foreground">
          {isDragAccept && "Drop file here..."}
          {isDragReject && "File is unsupported"}
        </p>
      ) : (
        <p className="text-center text-sm text-muted-foreground">
          Drag and drop or click to upload <br /> Accepts images between 10KB
          and 500KB
        </p>
      )}

      {imgUrl && (
        <Image
          onLoad={() => URL.revokeObjectURL(imgUrl)}
          className={cn(
            "object-cover absolute inset-0 size-full",
            !disabled && "hover:opacity-25 hover:grayscale-100"
          )}
          alt="source face"
          src={imgUrl}
          fill
        />
      )}
    </div>
  );
}
