import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useQueryState } from "nuqs";
import { startTransition } from "react";
import { Control, useController } from "react-hook-form";
import z from "zod";
import { TEXT_MAX_LENGTH, TTSFormSchema } from "../lib/schema";

export interface TextInputProps {
  disabled?: boolean;
  control: Control<z.infer<typeof TTSFormSchema>>;
}

export function TextInput({ control, disabled }: TextInputProps) {
  const [text, setText] = useQueryState("text");
  const { field, fieldState, formState } = useController({
    control,
    name: "text",
    defaultValue: text ?? "",
  });

  return (
    <Field data-invalid={fieldState.invalid} className="space-y-1.5">
      <div className="flex items-center justify-between">
        <FieldLabel htmlFor="text">Speech Script</FieldLabel>
        <span
          className={cn(
            "font-mono text-[10px]",
            (field.value?.length || 0) > TEXT_MAX_LENGTH
              ? "font-bold text-red-500"
              : "text-muted-foreground",
          )}
        >
          {field.value?.length || 0} / {TEXT_MAX_LENGTH} chars
        </span>
      </div>
      <Textarea
        {...field}
        aria-invalid={fieldState.invalid}
        disabled={formState.isSubmitting || disabled}
        className="border-border focus-visible:border-primary min-h-17.5 resize-none rounded-none p-2.5 font-mono text-xs shadow-none focus-visible:ring-0"
        onChange={(e) => {
          const text = e.currentTarget.value;
          field.onChange(text);
          setText(text, { startTransition });
        }}
      />
      <FieldDescription>
        The script that will be synthetically read by the cloned voice model.
      </FieldDescription>
      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
    </Field>
  );
}
