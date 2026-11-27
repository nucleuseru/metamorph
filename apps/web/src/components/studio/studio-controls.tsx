"use client";

import { BookmarkSimpleIcon, SparkleIcon, WaveformIcon } from "@phosphor-icons/react";
import { useId } from "react";

import { PhotoPicker } from "@/components/media/photo-picker";
import { VoicePicker } from "@/components/media/voice-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { MediaAsset, Persona } from "@/lib/api-client";
import {
  STUDIO_MODES,
  STYLE_SUGGESTIONS,
  characterSupportsMode,
  formatModeLabel,
  isCharacterCompatibleWithMode,
  type StudioMode,
} from "@/lib/creator-copy";
import { cn } from "@/lib/utils";

export interface StudioConfigState {
  mode: StudioMode;
  personaId: string;
  prompt: string;
  refImageAssetId: string;
  refAudioAssetId: string;
}

interface StudioControlsProps {
  config: StudioConfigState;
  isSessionActive: boolean;
  isApplyingConfig: boolean;
  isUploadingAsset: boolean;
  isStyleDirty: boolean;
  personas: Persona[];
  imageAssets: MediaAsset[];
  audioAssets: MediaAsset[];
  selectedMicId: string;
  onChange: (patch: Partial<StudioConfigState>) => void;
  onSelectCharacter: (characterId: string) => void;
  onApplyPrompt: () => void;
  onPickStyleSuggestion: (value: string) => void;
  onClearRefImage: () => void;
  onUploadRefImage: (file: File) => Promise<void>;
  onCaptureWebcamSnapshot: () => Promise<void>;
  onUploadRefAudio: (file: File) => Promise<void>;
  onClearRefAudio: () => void;
  onSelectRefImageAsset: (assetId: string) => void;
  onSelectRefAudioAsset: (assetId: string) => void;
  onSaveAsCharacter: () => void;
}

export function StudioControls({
  config,
  isSessionActive,
  isApplyingConfig,
  isUploadingAsset,
  isStyleDirty,
  personas,
  imageAssets,
  audioAssets,
  selectedMicId,
  onChange,
  onSelectCharacter,
  onApplyPrompt,
  onPickStyleSuggestion,
  onClearRefImage,
  onUploadRefImage,
  onCaptureWebcamSnapshot,
  onUploadRefAudio,
  onClearRefAudio,
  onSelectRefImageAsset,
  onSelectRefAudioAsset,
  onSaveAsCharacter,
}: StudioControlsProps) {
  const modeLabelId = useId();
  const hasVideo = config.mode === "video" || config.mode === "both";
  const hasVoice = config.mode === "voice" || config.mode === "both";
  const selectedCharacter = personas.find((p) => p.id === config.personaId) ?? null;
  const canSaveCharacter = Boolean(
    config.prompt.trim() || config.refImageAssetId || config.refAudioAssetId,
  );

  return (
    <Card size="sm" className="h-fit">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-lg font-semibold">Your Setup</CardTitle>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={!canSaveCharacter}
          onClick={onSaveAsCharacter}
        >
          <BookmarkSimpleIcon data-icon="inline-start" />
          Save Character
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {/* Mode Picker */}
        <div className="flex flex-col gap-2">
          <span id={modeLabelId} className="text-sm leading-5 font-semibold text-foreground">
            What to transform
          </span>
          <div
            role="radiogroup"
            aria-labelledby={modeLabelId}
            className="grid grid-cols-3 gap-1 rounded-full border border-border bg-surface p-1"
          >
            {STUDIO_MODES.map((opt) => {
              const selected = config.mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={isSessionActive}
                  onClick={() => {
                    const keepCharacter = Boolean(
                      selectedCharacter && characterSupportsMode(selectedCharacter, opt.value),
                    );
                    onChange({
                      mode: opt.value,
                      ...(keepCharacter ? {} : { personaId: "" }),
                    });
                  }}
                  className={cn(
                    "h-8 rounded-full px-2 text-xs font-semibold transition-colors disabled:opacity-50",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {isSessionActive ? (
            <p className="text-xs text-muted-foreground">End session to change mode.</p>
          ) : null}
        </div>

        {/* Characters Quick-Switcher */}
        <div className="flex flex-col gap-2">
          <span className="text-sm leading-5 font-semibold text-foreground">Characters</span>
          {personas.length > 0 ? (
            <div className="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto pr-0.5">
              {personas.map((character) => {
                const isSelected = character.id === config.personaId;
                const isCompatible =
                  !isSessionActive || isCharacterCompatibleWithMode(character, config.mode);
                return (
                  <button
                    key={character.id}
                    type="button"
                    aria-pressed={isSelected}
                    disabled={!isCompatible || isApplyingConfig}
                    onClick={() => onSelectCharacter(character.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border p-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
                      isSelected
                        ? "border-primary bg-accent-soft/60"
                        : "border-border bg-background hover:bg-surface",
                    )}
                  >
                    {character.refImageUrl ? (
                      <img
                        src={character.refImageUrl}
                        alt={character.name}
                        className="size-9 shrink-0 rounded-sm border border-border object-cover"
                      />
                    ) : (
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-border bg-surface text-accent-foreground">
                        <WaveformIcon className="size-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-foreground">
                        {character.name}
                      </p>
                      <p className="truncate text-[11px] font-medium text-muted-foreground">
                        {formatModeLabel(character.modalities)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Save your setup as a Character to switch looks in one click.
            </p>
          )}
          {selectedCharacter ? (
            <p className="text-xs text-muted-foreground">
              Prefilled from &ldquo;{selectedCharacter.name}&rdquo;. Changes below only apply to
              this session.
            </p>
          ) : null}
        </div>

        {/* Look Section */}
        {hasVideo ? (
          <>
            <Separator />
            <div className="flex flex-col gap-4">
              <PhotoPicker
                assets={imageAssets}
                selectedAssetId={config.refImageAssetId}
                onSelect={onSelectRefImageAsset}
                onUpload={onUploadRefImage}
                onClear={onClearRefImage}
                onCaptureWebcam={onCaptureWebcamSnapshot}
                isBusy={isUploadingAsset || isApplyingConfig}
                showClear={isSessionActive}
              />

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="studio-style">Style or outfit (optional)</Label>
                  {isSessionActive ? (
                    <Button
                      type="button"
                      size="xs"
                      variant={isStyleDirty ? "default" : "outline"}
                      disabled={isApplyingConfig}
                      onClick={onApplyPrompt}
                    >
                      {isApplyingConfig ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <SparkleIcon data-icon="inline-start" />
                      )}
                      Update Look
                    </Button>
                  ) : null}
                </div>

                <Textarea
                  id="studio-style"
                  placeholder="e.g. Cyberpunk neon jacket, anime style, warm studio lighting..."
                  value={config.prompt}
                  onChange={(e) => onChange({ prompt: e.target.value, personaId: "" })}
                />

                <div className="flex flex-wrap gap-1.5">
                  {STYLE_SUGGESTIONS.map((suggestion) => {
                    const isSelectedChip = config.prompt.trim() === suggestion.value;
                    return (
                      <button
                        key={suggestion.label}
                        type="button"
                        disabled={isApplyingConfig}
                        onClick={() => onPickStyleSuggestion(suggestion.value)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                          isSelectedChip
                            ? "border-primary/40 bg-accent-soft text-accent-foreground"
                            : "border-border bg-surface text-foreground hover:border-primary/40 hover:bg-accent-soft hover:text-accent-foreground",
                        )}
                      >
                        {suggestion.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        ) : null}

        {/* Voice Section */}
        {hasVoice ? (
          <>
            <Separator />
            <VoicePicker
              assets={audioAssets}
              selectedAssetId={config.refAudioAssetId}
              selectedMicId={selectedMicId}
              onSelect={onSelectRefAudioAsset}
              onUpload={onUploadRefAudio}
              onClear={!isSessionActive ? onClearRefAudio : undefined}
              isBusy={isUploadingAsset || isApplyingConfig}
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
