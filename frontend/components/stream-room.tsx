"use client";

import { useEffect, useRef, useState } from "react";

export default function StreamRoom({ roomId }: { roomId: string }) {
  const [remoteStream, setRemoteStream] = useState<MediaStream>();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const mediaStream = new MediaStream();
    videoRef.current!.srcObject = mediaStream;
    setRemoteStream(mediaStream);
  }, []);

  useEffect(() => {
    if (!remoteStream) return;

    const controller = new AbortController();

    const ws = new WebSocket(
      `ws://localhost:8000/ws?room_id=${roomId}&producer=false`
    );

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peer.addTransceiver("video", { direction: "recvonly" });
    peer.addTransceiver("audio", { direction: "recvonly" });

    ws.addEventListener(
      "open",
      async () => {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        ws.send(
          JSON.stringify({ event: "offer", offer: peer.localDescription })
        );
      },
      { signal: controller.signal }
    );

    peer.addEventListener("connectionstatechange", () => {
      console.log("connection state: " + peer.connectionState);
    });

    peer.addEventListener(
      "track",
      (event) => {
        remoteStream.addTrack(event.track);
      },
      { signal: controller.signal }
    );

    ws.addEventListener(
      "message",
      async (event) => {
        const data = JSON.parse(event.data);

        if (data.event === "answer") {
          await peer.setRemoteDescription(data.answer);
        } else if (data.event === "icecandidate") {
          await peer.addIceCandidate(data.icecandidate);
        }
      },
      { signal: controller.signal }
    );

    return () => {
      ws.close();
      peer.close();
      controller.abort("useEffect cleanup");
    };
  }, [roomId, remoteStream]);

  return <video className="w-dvw h-dvh object-cover" autoPlay muted ref={videoRef}></video>;
}
