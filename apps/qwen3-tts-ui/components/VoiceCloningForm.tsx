"use client";

import { api } from "@repo/convex/api";
import { Id } from "@repo/convex/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useState, useActionState, useEffect } from "react";

// Minimalist WAV conversion helper
async function convertToWav(file: File): Promise<Blob> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length * numberOfChannels * 2;
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + length, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numberOfChannels * 2, true);
  view.setUint16(32, numberOfChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, length, true);

  // PCM data
  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sample = Math.max(
        -1,
        Math.min(1, audioBuffer.getChannelData(channel)[i] ?? 1),
      );
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true,
      );
      offset += 2;
    }
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export function VoiceCloningForm({ sessionId }: { sessionId: string }) {
  const [fileId, setFileId] = useState<Id<"file">>();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  const cloneVoice = useAction(api.inference.cloneVoice);
  const generateUploadUrl = useMutation(api.file.generateUploadUrl);
  const file = useQuery(api.file.getFile, fileId ? { id: fileId } : "skip");
  const fileCount = useQuery(api.file.getFilesCount, { sessionId }) ?? 0;
  const credits = Math.max(0, 1000 - fileCount * 10);

  // Clear error when starting new action
  useEffect(() => {
    setErrorMessage(null);
  }, []);

  const [_, formAction, isPending] = useActionState(
    async (_: unknown, formData: FormData) => {
      setErrorMessage(null);
      try {
        const refAudio = formData.get("refAudio") as File;
        const refText = formData.get("refText") as string;
        const text = formData.get("text") as string;

        if (!refAudio || !refText || !text) {
          throw new Error("Please fill in all fields.");
        }

        const wavBlob = await convertToWav(refAudio);
        const wavFile = new File([wavBlob], "reference.wav", {
          type: "audio/wav",
        });

        const postUrl = await generateUploadUrl();
        const result = await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: wavFile,
        });

        if (!result.ok) throw new Error("Failed to upload audio.");

        const { storageId } = (await result.json()) as {
          storageId: Id<"_storage">;
        };

        const fileId = await cloneVoice({
          text,
          sessionId,
          ref_text: refText,
          ref_audio_storage_id: storageId,
        });

        setFileId(fileId);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "An unknown error occurred.");
      }
    },
    null,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Voice Cloning</h1>
        <div className="rounded-full bg-gray-900 px-3 py-1 text-sm text-gray-400">
          Credits: <span className="font-mono text-white">{credits}</span>
        </div>
      </header>

      {errorMessage && (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {errorMessage}
        </div>
      )}

      <form action={formAction} className="space-y-4">
        <div className="space-y-1">
            <label className="text-xs text-gray-500 uppercase tracking-wider">Reference Audio</label>
            <input
              name="refAudio"
              type="file"
              accept="audio/*"
              className="w-full rounded bg-gray-900 p-2 text-sm file:mr-4 file:rounded file:border-0 file:bg-gray-800 file:px-4 file:py-1 file:text-xs file:text-white hover:file:bg-gray-700"
              required
            />
        </div>
        
        <div className="space-y-1">
            <label className="text-xs text-gray-500 uppercase tracking-wider">Reference Transcript</label>
            <textarea
              name="refText"
              placeholder="e.g. 'Hello, this is my voice for cloning.'"
              className="h-20 w-full rounded bg-gray-900 p-2 text-sm focus:ring-1 focus:ring-white outline-none"
              required
            />
        </div>
        
        <div className="space-y-1">
            <label className="text-xs text-gray-500 uppercase tracking-wider">Target Text</label>
            <textarea
              name="text"
              placeholder="e.g. 'This text will be spoken by the cloned voice.'"
              className="h-20 w-full rounded bg-gray-900 p-2 text-sm focus:ring-1 focus:ring-white outline-none"
              required
            />
        </div>
        
        <button
          disabled={isPending || (fileId && file?.status === "generating")}
          className="w-full rounded bg-white p-2 text-sm font-bold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isPending 
            ? "Converting & Uploading..." 
            : fileId && file?.status === "generating"
            ? "Cloning in Progress..."
            : "Clone Voice"}
        </button>
      </form>

      {file?.status === "completed" && file.src && (
        <div className="rounded border border-green-900 bg-green-950 p-4 text-center">
          <p className="mb-2 text-sm text-green-200">Voice cloned successfully!</p>
          <a
            href={file.src}
            download="cloned-voice.wav"
            className="text-sm font-bold text-white underline hover:text-green-300"
          >
            Download Audio
          </a>
        </div>
      )}
    </div>
  );
}
