"use client";

import { useEffect, useId, useMemo, useState, type FormEvent } from "react";

import { PhotoPicker } from "@/components/media/photo-picker";
import { VoicePicker } from "@/components/media/voice-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  useAssets,
  useCreatePersona,
  useDeleteAsset,
  usePersonas,
  useUpdatePersona,
  useUploadAsset,
} from "@/hooks/use-api";
import type { CreatePersonaInput, MediaAsset, Persona } from "@/lib/api-client";
import {
  STUDIO_MODES,
  STYLE_SUGGESTIONS,
  formatFriendlyError,
  modalitiesFromMode,
  modeFromModalities,
  type StudioMode,
} from "@/lib/creator-copy";
import { cn } from "@/lib/utils";

interface CharacterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingCharacter: Persona | null;
  initialDraft?: Partial<CreatePersonaInput> | null;
  onSaved?: (character: Persona) => void;
}

export function CharacterDialog({
  open,
  onOpenChange,
  editingCharacter,
  initialDraft,
  onSaved,
}: CharacterDialogProps) {
  const modeLabelId = useId();
  const { data: imageAssets = [] } = useAssets("ref_image");
  const { data: audioAssets = [] } = useAssets("ref_audio");
  const { data: characters = [] } = usePersonas();
  const uploadMutation = useUploadAsset();
  const deleteAssetMutation = useDeleteAsset();
  const createMutation = useCreatePersona();
  const updateMutation = useUpdatePersona();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<StudioMode>("both");
  const [prompt, setPrompt] = useState("");
  const [refImageAssetId, setRefImageAssetId] = useState("");
  const [refAudioAssetId, setRefAudioAssetId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);

    const source = editingCharacter ?? initialDraft ?? null;
    const mods = source?.modalities ?? ["voice", "video"];

    setName(source?.name ?? "");
    setDescription(source?.description ?? "");
    setMode(modeFromModalities(mods));
    setPrompt(source?.prompt ?? "");
    setRefImageAssetId(source?.refImageAssetId ?? "");
    setRefAudioAssetId(source?.refAudioAssetId ?? "");
  }, [open, editingCharacter, initialDraft]);

  const hasLook = mode === "both" || mode === "video";
  const hasVoice = mode === "both" || mode === "voice";
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isAssetBusy = uploadMutation.isPending || deleteAssetMutation.isPending || isSaving;

  const protectedAssetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const character of characters) {
      if (character.refImageAssetId) ids.add(character.refImageAssetId);
      if (character.refAudioAssetId) ids.add(character.refAudioAssetId);
    }
    return ids;
  }, [characters]);

  async function handleUploadPhoto(file: File) {
    const asset = await uploadMutation.mutateAsync({
      kind: "ref_image",
      name: file.name,
      file,
    });
    setRefImageAssetId(asset.id);
  }

  async function handleUploadAudio(file: File) {
    const asset = await uploadMutation.mutateAsync({
      kind: "ref_audio",
      name: file.name,
      file,
    });
    setRefAudioAssetId(asset.id);
  }

  async function handleDeleteAsset(asset: MediaAsset) {
    if (protectedAssetIds.has(asset.id)) return;
    await deleteAssetMutation.mutateAsync(asset.id);
    if (asset.id === refImageAssetId) {
      setRefImageAssetId("");
    }
    if (asset.id === refAudioAssetId) {
      setRefAudioAssetId("");
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Give your character a name first.");
      return;
    }

    const modalities = modalitiesFromMode(mode);
    const payload: CreatePersonaInput = {
      name: trimmedName,
      description: description.trim() || null,
      modalities,
      prompt: hasLook ? prompt.trim() || null : null,
      refImageAssetId: hasLook ? refImageAssetId || null : null,
      refAudioAssetId: hasVoice ? refAudioAssetId || null : null,
      videoConfig: null,
      audioConfig: null,
    };

    try {
      const saved = editingCharacter
        ? await updateMutation.mutateAsync({ id: editingCharacter.id, body: payload })
        : await createMutation.mutateAsync(payload);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError(formatFriendlyError(err, "Could not save this character. Please try again."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editingCharacter ? "Edit Character" : "Create Character"}</DialogTitle>
          <DialogDescription>
            Save a look and voice setup to switch into it in one click while live.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="character-name">Name</FieldLabel>
              <Input
                id="character-name"
                required
                placeholder="e.g. Cyberpunk Host"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field>
              <FieldTitle id={modeLabelId}>What to transform</FieldTitle>
              <div
                role="radiogroup"
                aria-labelledby={modeLabelId}
                className="grid grid-cols-3 gap-1 rounded-full border border-border bg-surface p-1"
              >
                {STUDIO_MODES.map((opt) => {
                  const selected = mode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setMode(opt.value)}
                      className={cn(
                        "h-8 rounded-full px-2 text-xs font-semibold transition-colors",
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
            </Field>

            <Field>
              <FieldLabel htmlFor="character-note">Short note (optional)</FieldLabel>
              <Input
                id="character-note"
                placeholder="e.g. Friday night stream look"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </FieldGroup>

          {hasLook ? (
            <>
              <Separator />
              <div className="flex flex-col gap-4">
                <PhotoPicker
                  assets={imageAssets}
                  selectedAssetId={refImageAssetId}
                  onSelect={setRefImageAssetId}
                  onUpload={handleUploadPhoto}
                  onClear={() => setRefImageAssetId("")}
                  enableWebcamModal
                  onDeleteAsset={handleDeleteAsset}
                  protectedAssetIds={protectedAssetIds}
                  isBusy={isAssetBusy}
                />

                <Field>
                  <FieldLabel htmlFor="character-style">Style or outfit (optional)</FieldLabel>
                  <Textarea
                    id="character-style"
                    placeholder="e.g. Cyberpunk neon jacket, anime style, warm studio lighting..."
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {STYLE_SUGGESTIONS.map((suggestion) => {
                      const isSelectedChip = prompt.trim() === suggestion.value;
                      return (
                        <button
                          key={suggestion.label}
                          type="button"
                          onClick={() => setPrompt(suggestion.value)}
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
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
                </Field>
              </div>
            </>
          ) : null}

          {hasVoice ? (
            <>
              <Separator />
              <VoicePicker
                assets={audioAssets}
                selectedAssetId={refAudioAssetId}
                onSelect={setRefAudioAssetId}
                onUpload={handleUploadAudio}
                onClear={() => setRefAudioAssetId("")}
                onDeleteAsset={handleDeleteAsset}
                protectedAssetIds={protectedAssetIds}
                isBusy={isAssetBusy}
              />
            </>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || !name.trim()}>
              {isSaving ? <Spinner data-icon="inline-start" /> : null}
              {editingCharacter ? "Save changes" : "Create character"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
