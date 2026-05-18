import { GenerationProgressCard } from "./generation-progress-card";
import { FolderIcon, SoundWaveIcon } from "./icons";
import { VoiceItemCard } from "./voice-item-card";

export interface VoiceLibraryListProps {
  files: { _id: string | number; name: string; src?: string | null }[];
  isGenerating?: boolean;
  generatingVoiceName?: string;
}

export function VoiceLibraryList({
  files,
  isGenerating = false,
  generatingVoiceName = "New Voice Clone",
}: VoiceLibraryListProps) {
  return (
    <section className="space-y-4 lg:col-span-5">
      <div className="flex items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-xs font-bold tracking-widest text-white/80 uppercase">
          <FolderIcon className="h-4 w-4 text-white/60" />
          Voice Library
        </h2>
        <span className="rounded-full border border-white/10 bg-white/10 px-3 py-0.5 text-xs font-semibold text-white/80">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
      </div>

      {isGenerating && (
        <GenerationProgressCard voiceName={generatingVoiceName} />
      )}

      <div className="space-y-4">
        {files.length === 0 && !isGenerating && (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 bg-[#0f0f11]/40 p-12 text-center shadow-inner backdrop-blur-sm">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white/40 shadow-sm">
              <SoundWaveIcon className="h-7 w-7" />
            </div>
            <h3 className="text-sm font-bold text-white">
              No voices cloned yet
            </h3>
            <p className="mt-1.5 max-w-[220px] text-xs leading-relaxed text-white/50">
              Submit the form on the left to generate your first AI voice clone.
            </p>
          </div>
        )}

        {files.map((item) => (
          <VoiceItemCard
            key={String(item._id)}
            name={item.name}
            src={item.src}
          />
        ))}
      </div>
    </section>
  );
}
