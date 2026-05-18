import { SparklesIcon } from "./icons";

export interface StudioHeaderProps {
  title?: string;
  subtitle?: string;
  credits?: number;
}

export function StudioHeader({
  title = "Meta Morph",
  subtitle = "Minimalist high-fidelity AI voice cloning",
  credits = 0,
}: StudioHeaderProps) {
  return (
    <header className="flex flex-col justify-between gap-4 border-b border-white/10 pb-6 sm:flex-row sm:items-center">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-black shadow-[0_0_25px_rgba(255,255,255,0.2)]">
          <SparklesIcon className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {title}
          </h1>
          <p className="text-xs text-white/60 sm:text-sm">{subtitle}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 self-start rounded-2xl border border-white/10 bg-white/5 px-5 py-2.5 shadow-inner backdrop-blur-md sm:self-center">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-xs font-semibold tracking-wider text-white/60 uppercase">
            Credits
          </span>
        </div>
        <span className="font-mono text-base font-bold text-white">
          {credits}
        </span>
      </div>
    </header>
  );
}
