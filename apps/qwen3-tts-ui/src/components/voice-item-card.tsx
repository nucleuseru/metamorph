import { DownloadIcon, PlayWaveIcon } from "./icons";

export interface VoiceItemCardProps {
  name: string;
  src?: string | null;
}

export function VoiceItemCard({ name, src }: VoiceItemCardProps) {
  return (
    <div className="group relative flex flex-col justify-between gap-4 rounded-3xl border border-white/10 bg-[#0f0f11]/80 p-5 shadow-xl backdrop-blur-xl transition-all duration-300 hover:border-white/20 hover:bg-[#151518]/80 hover:shadow-2xl sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3.5 overflow-hidden">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white shadow-sm transition-colors group-hover:bg-white/10">
            <PlayWaveIcon className="h-5 w-5 text-white/80" />
          </div>
          <div className="overflow-hidden pr-2">
            <h3 className="truncate text-sm font-bold text-white transition-colors group-hover:text-white/90">
              {name}
            </h3>
            <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-white/40">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]"></span>
              Completed
            </p>
          </div>
        </div>

        {src && (
          <a
            href={src}
            download={`${name}.wav`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-bold text-white/80 shadow-sm backdrop-blur-md transition-all duration-200 hover:border-white hover:bg-white hover:text-black hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            <span>Download</span>
          </a>
        )}
      </div>

      {src && (
        <div className="w-full pt-1">
          <audio
            controls
            src={src}
            className="h-10 w-full rounded-xl bg-white/5 opacity-85 transition-opacity hover:opacity-100 [&::-webkit-media-controls-current-time-display]:text-white [&::-webkit-media-controls-panel]:bg-white/10 [&::-webkit-media-controls-panel]:px-2 [&::-webkit-media-controls-time-remaining-display]:text-white"
          />
        </div>
      )}
    </div>
  );
}
