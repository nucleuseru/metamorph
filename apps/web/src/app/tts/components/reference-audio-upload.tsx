import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { FileAudioIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { Control, useController } from "react-hook-form";
import z from "zod";
import { TTSFormSchema } from "../lib/schema";

export interface ReferenceAudioUploadProps {
  disabled?: boolean;
  control: Control<z.infer<typeof TTSFormSchema>>;
}

export function ReferenceAudioUpload({
  control,
  disabled,
}: ReferenceAudioUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const { field, fieldState, formState } = useController({
    control,
    name: "file",
  });

  return (
    <Field data-invalid={fieldState.invalid} className="space-y-1.5">
      <FieldLabel htmlFor="file">Reference Voice Audio</FieldLabel>

      <input
        type="file"
        accept="audio/mpeg,audio/ogg,audio/wav,audio/webm"
        className="hidden"
        ref={fileInputRef}
        name={field.name}
        onBlur={field.onBlur}
        disabled={!!field.disabled || formState.isSubmitting || disabled}
        onChange={(e) => {
          const file = e.currentTarget.files?.item(0);
          field.onChange(file);

          if (!file) return;

          setAudioUrl((prevUrl) => {
            if (prevUrl) URL.revokeObjectURL(prevUrl);
            return URL.createObjectURL(file);
          });
        }}
      />

      {(!field.value as boolean) ? (
        <div
          onClick={() =>
            !formState.isSubmitting &&
            !disabled &&
            fileInputRef.current?.click()
          }
          className={cn(
            "border-border bg-muted hover:border-primary hover:bg-card flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed p-6 text-center transition duration-200",
            (formState.isSubmitting || disabled) &&
              "cursor-not-allowed opacity-50",
          )}
        >
          <UploadSimpleIcon className="text-muted-foreground h-6 w-6" />
          <span className="text-muted-foreground text-xs font-semibold">
            Click to upload voice reference
          </span>
          <span className="text-muted-foreground font-mono text-[10px]">
            Accepts MP3, WAV, OGG, WEBM
          </span>
        </div>
      ) : (
        <div className="border-border flex flex-col gap-3 border p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="border-border bg-muted border p-2">
                <FileAudioIcon className="h-5 w-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-muted-foreground max-w-60 truncate font-mono text-xs font-bold">
                  {(field.value as File).name.slice(0, 10)}...
                </span>
                <span className="text-muted-foreground font-mono text-[10px]">
                  {((field.value as File).size / (1024 * 1024)).toFixed(2)} MB •{" "}
                  {(field.value as File).type}
                </span>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="h-auto rounded-none border border-transparent px-2 py-1 text-xs hover:border-red-200 hover:bg-red-50 hover:text-red-600"
              onClick={() => {
                field.onChange(null);
                setAudioUrl((prev) => {
                  if (prev) URL.revokeObjectURL(prev);
                  return null;
                });
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              disabled={formState.isSubmitting || disabled}
            >
              Remove
            </Button>
          </div>
          {audioUrl && (
            <div className="border-border flex flex-col gap-1 border-t pt-2">
              <span className="text-muted-foreground font-mono text-[9px] font-bold uppercase">
                Source Voice Preview:
              </span>
              <audio src={audioUrl} controls className="h-8 w-full text-xs" />
            </div>
          )}
        </div>
      )}

      <FieldDescription className="text-xs">
        Provide an audio sample of the voice structure to clone.
      </FieldDescription>
      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
    </Field>
  );
}
