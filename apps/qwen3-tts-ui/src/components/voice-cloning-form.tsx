"use client";

import { convertToWav } from "@/lib/utils";
import { api } from "@repo/convex/api";
import { Id } from "@repo/convex/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useActionState, useState } from "react";
import { CloneVoiceForm } from "./clone-voice-form";
import { StudioHeader } from "./studio-header";
import { VoiceLibraryList } from "./voice-library-list";

export function VoiceCloningForm({ sessionId }: { sessionId: string }) {
  const [fileId, setFileId] = useState<Id<"file">>();
  const [selectedFileName, setSelectedFileName] = useState("");

  const file = useQuery(api.file.getFile, fileId ? { id: fileId } : "skip");
  const files = useQuery(api.file.getFiles, { sessionId });
  const credits = files ? Math.max(0, 1000 - files.length * 10) : 0;

  const generateUploadUrl = useMutation(api.file.generateUploadUrl);
  const cloneVoice = useAction(api.inference.cloneVoice);

  const [error, formAction, isPending] = useActionState(
    async (_: unknown, formData: FormData) => {
      try {
        const name = formData.get("name") as string;
        const refAudio = formData.get("refAudio") as File;
        const refText = formData.get("refText") as string;
        const text = formData.get("text") as string;

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
          name,
          text,
          sessionId,
          ref_text: refText,
          ref_audio_storage_id: storageId,
        });

        setFileId(fileId);
        setSelectedFileName("");
      } catch (error) {
        if (error instanceof Error) return error.message;
        return "An unknown error occurred.";
      }
    },
    null,
  );

  const isGenerating = Boolean(fileId && file?.status === "generating");

  return (
    <div className="mx-auto max-w-6xl space-y-8 font-sans">
      <StudioHeader credits={credits - (isPending ? 10 : 0)} />

      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
        <CloneVoiceForm
          formAction={formAction}
          isPending={isPending}
          isGenerating={isGenerating}
          error={error}
          selectedFileName={selectedFileName}
          onFileSelect={(file) => {
            setSelectedFileName(file?.name ?? "");
          }}
        />

        <VoiceLibraryList
          files={files ?? []}
          isGenerating={isGenerating}
          generatingVoiceName={file?.name ?? "New Voice Clone"}
        />
      </div>
    </div>
  );
}
