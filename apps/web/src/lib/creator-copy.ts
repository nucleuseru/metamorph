import type { Modality } from "@metamorph/shared";

import { ApiError, type Persona } from "@/lib/api-client";

export type StudioMode = "both" | "video" | "voice";

export const STUDIO_MODES: ReadonlyArray<{
  readonly value: StudioMode;
  readonly label: string;
}> = [
  { value: "both", label: "Look & Voice" },
  { value: "video", label: "Look only" },
  { value: "voice", label: "Voice only" },
];

export const STYLE_SUGGESTIONS: ReadonlyArray<{
  readonly label: string;
  readonly value: string;
}> = [
  {
    label: "Cyberpunk neon",
    value: "Cyberpunk neon jacket with glowing street lights",
  },
  {
    label: "Anime style",
    value: "Clean anime character illustration style",
  },
  {
    label: "Studio blazer",
    value: "Tailored dark blazer with crisp studio lighting",
  },
  {
    label: "Fantasy armor",
    value: "Ornate fantasy armor with warm cinematic lighting",
  },
  {
    label: "90s VHS",
    value: "Retro 90s VHS camcorder look with vintage streetwear",
  },
  {
    label: "Streetwear",
    value: "Modern oversized streetwear hoodie in soft daylight",
  },
];

export function modalitiesFromMode(mode: StudioMode): Modality[] {
  if (mode === "voice") return ["voice"];
  if (mode === "video") return ["video"];
  return ["voice", "video"];
}

export function modeFromModalities(modalities: ReadonlyArray<Modality>): StudioMode {
  const hasVoice = modalities.includes("voice");
  const hasVideo = modalities.includes("video");
  if (hasVoice && hasVideo) return "both";
  if (hasVideo) return "video";
  return "voice";
}

export function formatModeLabel(modalities: ReadonlyArray<Modality>): string {
  const mode = modeFromModalities(modalities);
  if (mode === "both") return "Look & Voice";
  if (mode === "video") return "Look only";
  return "Voice only";
}

export function characterSupportsMode(character: Persona, mode: StudioMode): boolean {
  const hasLook =
    Boolean(character.refImageAssetId || character.prompt?.trim()) ||
    character.modalities.includes("video");
  const hasVoice = Boolean(character.refAudioAssetId) || character.modalities.includes("voice");

  if (mode === "both") return hasLook && hasVoice;
  if (mode === "video") return hasLook;
  return hasVoice;
}

export function isCharacterCompatibleWithMode(character: Persona, mode: StudioMode): boolean {
  if (mode === "both") return true;
  return characterSupportsMode(character, mode);
}

export function formatFriendlyError(
  err: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = raw.toLowerCase();
  const status = err instanceof ApiError ? err.status : undefined;

  if (
    lower.includes("notallowederror") ||
    lower.includes("permission denied") ||
    lower.includes("permission dismissed") ||
    lower.includes("denied by system")
  ) {
    return "Please allow camera and microphone access in your browser to continue.";
  }

  if (
    lower.includes("notfounderror") ||
    lower.includes("requested device not found") ||
    lower.includes("devicesnotfounderror") ||
    lower.includes("overconstrainederror")
  ) {
    return "We couldn't find a connected camera or microphone. Check your device settings.";
  }

  if (
    status === 409 ||
    lower.includes("409") ||
    lower.includes("already active") ||
    lower.includes("conflict") ||
    lower.includes("superseded")
  ) {
    return "You already have a live session running. Reconnecting now...";
  }

  if (
    (lower.includes("asset") || lower.includes("ref_image") || lower.includes("ref_audio")) &&
    (lower.includes("not found") || status === 404)
  ) {
    return "That photo or voice clip is no longer available. Please pick another one.";
  }

  if (lower.includes("persona") && (lower.includes("not found") || status === 404)) {
    return "That character could not be found.";
  }

  if (
    status === 413 ||
    lower.includes("413") ||
    lower.includes("too large") ||
    lower.includes("exceeds")
  ) {
    return "That file is too large. Try a smaller photo or shorter voice clip.";
  }

  if (
    status === 415 ||
    lower.includes("415") ||
    lower.includes("mime") ||
    lower.includes("unsupported")
  ) {
    return "That file type isn't supported. Try a JPG/PNG photo or MP3/WAV/M4A voice clip.";
  }

  if (
    lower.includes("provider") ||
    lower.includes("gpu") ||
    lower.includes("runpod") ||
    lower.includes("vast") ||
    lower.includes("orchestrator") ||
    lower.includes("override") ||
    lower.includes("capacity")
  ) {
    return "Something went wrong starting your studio. Please try again in a moment.";
  }

  if (
    status === 503 ||
    lower.includes("503") ||
    lower.includes("not ready") ||
    lower.includes("warming")
  ) {
    return "Your studio is still getting ready. Try again in a few seconds.";
  }

  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    lower.includes("load failed")
  ) {
    return "Could not reach Metamorph. Check your internet connection and try again.";
  }

  if (
    lower.includes("websocket") ||
    lower.includes("socket") ||
    lower.includes("disconnect") ||
    lower.includes("connection closed") ||
    lower.includes("connection lost")
  ) {
    return "Your live connection was interrupted. Trying to reconnect...";
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Starting your studio took longer than expected. Please try again.";
  }

  if (
    status === 500 ||
    status === 502 ||
    lower.includes("502") ||
    lower.includes("500") ||
    lower.includes("bad gateway")
  ) {
    return "Something went wrong starting your studio. Please try again in a moment.";
  }

  return fallback;
}
