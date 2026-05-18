import { UploadIcon } from "./icons";

export interface FormInputProps {
  label: string;
  sublabel?: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
}

export function FormInput({
  label,
  sublabel,
  name,
  placeholder,
  required = false,
  type = "text",
}: FormInputProps) {
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between text-xs font-bold tracking-wider text-white/70 uppercase">
        <span>{label}</span>
        {sublabel && (
          <span className="text-[10px] font-normal text-white/40 normal-case">
            {sublabel}
          </span>
        )}
      </label>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3.5 text-sm text-white placeholder-white/30 transition-all duration-200 focus:border-white/40 focus:bg-white/10 focus:ring-4 focus:ring-white/5 focus:outline-none"
        required={required}
      />
    </div>
  );
}

export interface FormTextareaProps {
  label: string;
  sublabel?: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

export function FormTextarea({
  label,
  sublabel,
  name,
  placeholder,
  required = false,
  className = "h-24",
}: FormTextareaProps) {
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between text-xs font-bold tracking-wider text-white/70 uppercase">
        <span>{label}</span>
        {sublabel && (
          <span className="text-[10px] font-normal text-white/40 normal-case">
            {sublabel}
          </span>
        )}
      </label>
      <textarea
        name={name}
        placeholder={placeholder}
        className={`${className} w-full resize-none rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white placeholder-white/30 transition-all duration-200 focus:border-white/40 focus:bg-white/10 focus:ring-4 focus:ring-white/5 focus:outline-none`}
        required={required}
      />
    </div>
  );
}

export interface FormFileDropzoneProps {
  label: string;
  sublabel?: string;
  name: string;
  accept?: string;
  required?: boolean;
  selectedFileName: string;
  onFileSelect: (file: File | null) => void;
}

export function FormFileDropzone({
  label,
  sublabel,
  name,
  accept = "audio/*",
  required = false,
  selectedFileName,
  onFileSelect,
}: FormFileDropzoneProps) {
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between text-xs font-bold tracking-wider text-white/70 uppercase">
        <span>{label}</span>
        {sublabel && (
          <span className="text-[10px] font-normal text-white/40 normal-case">
            {sublabel}
          </span>
        )}
      </label>
      <div className="group relative">
        <input
          name={name}
          type="file"
          accept={accept}
          onChange={(e) => {
            onFileSelect(e.target.files?.[0] ?? null);
          }}
          className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          required={required}
        />
        <div
          className={`flex items-center justify-between rounded-2xl border ${selectedFileName ? "border-white/30 bg-white/10" : "border-white/10 bg-white/5"} p-3 transition-all duration-200 group-hover:border-white/30 group-hover:bg-white/10 sm:p-4`}
        >
          <div className="flex items-center gap-3.5 overflow-hidden">
            <div
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${selectedFileName ? "bg-white text-black shadow-lg" : "bg-white/10 text-white/60"} transition-all`}
            >
              <UploadIcon className="h-6 w-6" />
            </div>
            <div className="overflow-hidden pr-2">
              <p className="truncate text-sm font-semibold text-white">
                {selectedFileName || "Upload audio sample"}
              </p>
              <p className="mt-0.5 truncate text-xs text-white/40">
                {selectedFileName
                  ? "Click or drag to replace"
                  : "WAV, MP3 up to 10MB"}
              </p>
            </div>
          </div>
          <div className="shrink-0 pl-2">
            <span className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/80 shadow-sm transition-all group-hover:bg-white/20 group-hover:text-white">
              {selectedFileName ? "Change" : "Browse"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
