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
  const [localStream, setLocalStream] = useState<MediaStream>();

  const [ws, setWs] = useState<WebSocket>();
  const [peer, setPeer] = useState<RTCPeerConnection>();

  const handleStart = useCallback(async () => {
    setError("");

    if (!sourceFace) {
      setError("Select a source face to start streaming");
      return;
    }

    if (!isAudioVideoEnabled) {
      setError("Enable audio and video to start streaming");
      return;
    }

    const formData = new FormData();
    formData.append("file", sourceFace);

    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/setup`, {
      method: "post",
      body: formData,
    });

    const { success, data } = await res.json();

    if (!success) {
      setError(
        "Failed to setup, please ensure your source face meet our guidelines"
      );
      return;
    }

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peer.addTransceiver("video", { direction: "sendonly" });
    peer.addTransceiver("audio", { direction: "sendonly" });

    localStream!.getTracks().forEach((track) => {
      peer.addTrack(track, localStream!);
    });

    const ws = new WebSocket(
      `ws://localhost:8000/ws?room_id=${data.room_id}&producer=true`
    );

    setWs(ws);
    setPeer(peer);
    setStreaming(true);

    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "connected") {
        console.log(data.room_id);
      }
    });

    ws.addEventListener("open", async () => {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      ws.send(JSON.stringify({ event: "offer", offer: peer.localDescription }));
    });

    ws.addEventListener("message", async (event) => {
      const data = JSON.parse(event.data);

      if (data.event === "answer") {
        await peer.setRemoteDescription(data.answer);
      } else if (data.event === "icecandidate") {
        await peer.addIceCandidate(data.icecandidate);
      }
    });
  }, [sourceFace, isAudioVideoEnabled, localStream]);

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

        {isStreaming ? (
          <Button>Stop streaming</Button>
        ) : (
          <Button>Start streaming</Button>
        )}
      </form>

      <div>
        <UserMedia
          setMediaStream={setLocalStream}
          isAudioVideoEnabled={isAudioVideoEnabled}
          setAudioVideoEnabled={setAudioVideoEnabled}
        />
      </div>
    </div>
  );
}

function UserMedia({
  setMediaStream,
  isAudioVideoEnabled,
  setAudioVideoEnabled,
}: {
  isAudioVideoEnabled: boolean;
  setMediaStream: (mediaStream: MediaStream) => void;
  setAudioVideoEnabled: (value: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleEnableAudioVideo = useCallback(async () => {
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    videoRef.current!.srcObject = mediaStream;

    setAudioVideoEnabled(true);
    setMediaStream(mediaStream);
  }, [setAudioVideoEnabled, setMediaStream]);

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
