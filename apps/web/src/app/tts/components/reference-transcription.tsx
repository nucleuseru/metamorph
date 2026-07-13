import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useQueryState } from "nuqs";
import { startTransition } from "react";
import { Control, useController } from "react-hook-form";
import z from "zod";
import { TTSFormSchema } from "../lib/schema";

export interface ReferenceTranscriptionProps {
  disabled?: boolean;
  control: Control<z.infer<typeof TTSFormSchema>>;
}

export function ReferenceTranscription({
  control,
  disabled,
}: ReferenceTranscriptionProps) {
  const [referenceText, setReferenceText] = useQueryState("referenceText");
  const { field, fieldState, formState } = useController({
    control,
    name: "referenceText",
    defaultValue: referenceText ?? "",
  });

  return (
    <Field data-invalid={fieldState.invalid} className="space-y-1.5">
      <FieldLabel htmlFor="referenceText">Reference Transcription</FieldLabel>
      <Textarea
        {...field}
        aria-invalid={fieldState.invalid}
        disabled={formState.isSubmitting || disabled}
        className="border-border focus-visible:border-primary min-h-15 resize-none rounded-none p-2.5 text-xs shadow-none focus-visible:ring-0"
        placeholder="Enter the exact text spoken in the reference audio sample..."
        onChange={(e) => {
          const text = e.currentTarget.value;
          field.onChange(text);
          void setReferenceText(text, { startTransition });
        }}
      />
      <FieldDescription className="text-xs">
        This text must matches the reference audio.
      </FieldDescription>
      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
    </Field>
  );
}
