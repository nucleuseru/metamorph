import { SpinnerIcon } from "./icons";

export interface GenerationProgressCardProps {
  voiceName?: string;
}

export function GenerationProgressCard({
  voiceName = "New Voice Clone",
}: GenerationProgressCardProps) {
  return (
    <div className="relative animate-pulse overflow-hidden rounded-3xl border border-white/20 bg-linear-to-b from-white/10 to-white/5 p-6 shadow-2xl backdrop-blur-xl">
      <div className="absolute top-0 left-0 h-1 w-full animate-[shimmer_2s_infinite] bg-linear-to-r from-transparent via-white to-transparent" />
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/20 text-white">
          <SpinnerIcon className="h-6 w-6 animate-spin" />
        </div>
        <div className="space-y-1.5 overflow-hidden pr-2">
          <div className="flex items-center gap-2.5">
            <h3 className="truncate text-sm font-bold text-white">
              {voiceName}
            </h3>
            <span className="rounded-lg border border-white/10 bg-white/20 px-2.5 py-0.5 text-[10px] font-bold tracking-wider text-white uppercase">
              Generating
            </span>
          </div>
          <p className="line-clamp-2 text-xs leading-relaxed text-white/60">
            Synthesizing target audio using Qwen-3 AI. This usually takes 30 to
            60 seconds...
          </p>
        </div>
      </div>
    </div>
  );
}
