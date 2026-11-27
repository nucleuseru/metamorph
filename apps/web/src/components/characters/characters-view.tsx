"use client";

import {
  BroadcastIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { CharacterDialog } from "@/components/characters/character-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useDeletePersona, usePersonas } from "@/hooks/use-api";
import type { Persona } from "@/lib/api-client";
import { formatFriendlyError, formatModeLabel } from "@/lib/creator-copy";

export function CharactersView() {
  const { data: characters = [], isLoading, error } = usePersonas();
  const deleteMutation = useDeletePersona();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const [playingCharacterId, setPlayingCharacterId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<Persona | null>(null);
  const [characterToDelete, setCharacterToDelete] = useState<Persona | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      audioCleanupRef.current?.();
      audioCleanupRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
        audioRef.current = null;
      }
    };
  }, []);

  function stopAudioPreview() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlayingCharacterId(null);
  }

  function handleToggleVoicePreview(character: Persona) {
    if (!character.refAudioUrl) return;
    setActionError(null);

    if (playingCharacterId === character.id) {
      stopAudioPreview();
      return;
    }

    if (!audioRef.current) {
      const el = new Audio();
      const onEnded = () => setPlayingCharacterId(null);
      const onError = () => {
        if (!el.getAttribute("src")) return;
        setPlayingCharacterId(null);
        setActionError("Could not play that voice clip.");
      };
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);
      audioCleanupRef.current = () => {
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
      };
      audioRef.current = el;
    }

    audioRef.current.pause();
    audioRef.current.src = character.refAudioUrl;
    setPlayingCharacterId(character.id);
    void audioRef.current.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setPlayingCharacterId(null);
      setActionError("Could not play that voice clip.");
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-4xl leading-[43px] font-semibold tracking-[-0.5px] text-foreground">
            Characters
          </h1>
          <p className="max-w-2xl text-base leading-[22.4px] font-medium text-muted-foreground">
            Save your favorite looks and voices to switch in one click while live.
          </p>
        </div>

        <Button
          type="button"
          onClick={() => {
            setEditingCharacter(null);
            setDialogOpen(true);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          New Character
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {formatFriendlyError(error, "Could not load your characters right now.")}
          </AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      ) : characters.length === 0 ? (
        <Card size="sm">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-14 text-center">
            <p className="text-sm text-muted-foreground">
              No characters saved yet. Create one to switch looks and voices in one click while
              live.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditingCharacter(null);
                setDialogOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Create your first character
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {characters.map((character) => {
            const isPlaying = playingCharacterId === character.id;
            return (
              <Card key={character.id} size="sm" className="justify-between">
                <CardHeader className="gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle>{character.name}</CardTitle>
                    <Badge variant="accent">{formatModeLabel(character.modalities)}</Badge>
                  </div>
                  {character.description ? (
                    <CardDescription>{character.description}</CardDescription>
                  ) : null}
                </CardHeader>

                <CardContent className="flex flex-col gap-4">
                  {character.refImageUrl ? (
                    <div className="aspect-video w-full overflow-hidden rounded-md border border-border bg-surface">
                      <img
                        src={character.refImageUrl}
                        alt={character.name}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ) : character.refAudioUrl ? (
                    <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-border bg-surface text-muted-foreground">
                      <WaveformIcon className="size-7 text-accent-foreground" />
                      <span className="text-xs font-medium">Voice Character</span>
                    </div>
                  ) : null}

                  {character.prompt ? (
                    <p className="line-clamp-2 rounded-md border border-border bg-surface p-3 text-xs leading-relaxed text-muted-foreground">
                      {character.prompt}
                    </p>
                  ) : null}

                  {character.refAudioUrl ? (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <WaveformIcon className="size-4 shrink-0 text-accent-foreground" />
                        <span className="truncate text-xs font-medium text-foreground">
                          Voice clip attached
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={
                          isPlaying
                            ? `Pause ${character.name} voice clip`
                            : `Play ${character.name} voice clip`
                        }
                        onClick={() => handleToggleVoicePreview(character)}
                      >
                        {isPlaying ? <PauseIcon /> : <PlayIcon />}
                      </Button>
                    </div>
                  ) : null}

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <Button
                      size="sm"
                      className="flex-1"
                      render={
                        <Link href={`/studio?characterId=${encodeURIComponent(character.id)}`} />
                      }
                      nativeButton={false}
                    >
                      <BroadcastIcon data-icon="inline-start" />
                      Open in Studio
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label={`Edit ${character.name}`}
                      onClick={() => {
                        setEditingCharacter(character);
                        setDialogOpen(true);
                      }}
                    >
                      <PencilSimpleIcon />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${character.name}`}
                      className="text-destructive-text hover:bg-destructive/15 hover:text-destructive-text"
                      onClick={() => setCharacterToDelete(character)}
                    >
                      <TrashIcon />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CharacterDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingCharacter={editingCharacter}
      />

      <Dialog
        open={Boolean(characterToDelete)}
        onOpenChange={(open) => !open && setCharacterToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete character?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">{characterToDelete?.name}</span>? Your
              saved photos and voice clips will remain available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={() => setCharacterToDelete(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (!characterToDelete) return;
                if (playingCharacterId === characterToDelete.id) {
                  stopAudioPreview();
                }
                deleteMutation.mutate(characterToDelete.id, {
                  onSuccess: () => setCharacterToDelete(null),
                  onError: (err) => {
                    setActionError(
                      formatFriendlyError(
                        err,
                        "Could not delete that character. Please try again.",
                      ),
                    );
                    setCharacterToDelete(null);
                  },
                });
              }}
            >
              {deleteMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
