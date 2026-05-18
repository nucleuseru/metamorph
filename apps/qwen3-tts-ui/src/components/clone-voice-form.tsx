import Form from "next/form";
import { FormFileDropzone, FormInput, FormTextarea } from "./form-controls";
import { AlertIcon, SpinnerIcon, WaveIcon } from "./icons";

export interface CloneVoiceFormProps {
  isPending: boolean;
  error?: string | null;
  selectedFileName: string;
  formAction: (formData: FormData) => void;
  onFileSelect: (file: File | null) => void;
}

export function CloneVoiceForm({
  error,
  isPending,
  formAction,
  onFileSelect,
  selectedFileName,
}: CloneVoiceFormProps) {
  return (
    <section className="space-y-4 lg:col-span-7">
      <div className="flex items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-xs font-bold tracking-widest text-white/80 uppercase">
          <WaveIcon className="h-4 w-4 text-white/60" />
          Clone a Voice
        </h2>
        <span className="text-xs text-white/40">* All fields required</span>
      </div>

      <Form
        action={formAction}
        className="space-y-6 rounded-3xl border border-white/10 bg-[#0f0f11]/80 p-6 shadow-2xl backdrop-blur-xl transition-all duration-300 hover:border-white/20 sm:p-8"
      >
        {error && (
          <div className="flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200 backdrop-blur-md">
            <AlertIcon className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
            <div>
              <p className="font-semibold text-red-300">Cloning Failed</p>
              <p className="mt-0.5 text-xs text-red-200/80">{error}</p>
            </div>
          </div>
        )}

        <FormInput
          label="Voice Name"
          sublabel="Identifier for this clone"
          name="name"
          placeholder="e.g. Sarah Studio, Podcast Host"
          required
        />

        <FormFileDropzone
          label="Reference Audio"
          sublabel="Clean, solo voice sample (WAV/MP3)"
          name="refAudio"
          required
          selectedFileName={selectedFileName}
          onFileSelect={(file) => {
            onFileSelect(file);
          }}
        />

        <FormTextarea
          label="Reference Transcript"
          sublabel="Exact words spoken in reference audio"
          name="refText"
          placeholder="Type the exact transcript of the uploaded reference audio..."
          required
          className="h-24"
        />

        <FormTextarea
          label="Target Text"
          sublabel="Text to be synthesized"
          name="text"
          placeholder="Type what you want the cloned voice to say..."
          required
          className="h-28"
        />

        <button
          disabled={isPending}
          className="relative w-full overflow-hidden rounded-2xl bg-white p-4 text-sm font-bold text-black shadow-xl transition-all duration-300 hover:opacity-90 hover:shadow-[0_0_30px_rgba(255,255,255,0.3)] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
        >
          <div className="flex items-center justify-center gap-2.5">
            {isPending && (
              <SpinnerIcon className="h-5 w-5 animate-spin text-black" />
            )}
            <span>
              {isPending ? "Converting & Uploading..." : "Clone Voice"}
            </span>
          </div>
        </button>
      </Form>
    </section>
  );
}
