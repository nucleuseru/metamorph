"use client";

import type { OrchestratedSessionStatus } from "@metamorph/shared";
import { TERMINAL_SESSION_STATUSES } from "@metamorph/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { CharacterDialog } from "@/components/characters/character-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  queryKeys,
  useActiveSession,
  useAssets,
  useCreateSession,
  usePersonas,
  useSessionEngineStatus,
  useStopSession,
  useUpdateSessionConfig,
  useUploadAsset,
  useUploadSessionAssets,
} from "@/hooks/use-api";
import {
  ApiError,
  getSession,
  isAssetFetchFallbackError,
  subscribeSessionEvents,
  type CreatePersonaInput,
  type SessionDetail,
} from "@/lib/api-client";
import {
  characterSupportsMode,
  formatFriendlyError,
  isCharacterCompatibleWithMode,
  modalitiesFromMode,
  modeFromModalities,
} from "@/lib/creator-copy";
import {
  LiveOutputRecorder,
  MicLevelMonitor,
  captureCanvasSnapshot,
  captureWebcamSnapshot,
  enumerateMediaDevices,
  type MediaDeviceOption,
} from "@/lib/media/devices";
import {
  RealtimeSessionClient,
  type EngineStreamPhase,
  type VideoActivityState,
} from "@/lib/media/session-engine-client";

import { StudioControls, type StudioConfigState } from "./studio-controls";
import { StudioStage, type StudioViewLayout } from "./studio-stage";

const DEFAULT_CONFIG: StudioConfigState = {
  mode: "both",
  personaId: "",
  prompt: "",
  refImageAssetId: "",
  refAudioAssetId: "",
};

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function StudioView() {
  const searchParams = useSearchParams();
  const initialCharacterParam =
    searchParams.get("characterId") ?? searchParams.get("personaId") ?? "";

  const qc = useQueryClient();
  const { data: activeSession } = useActiveSession();
  const activeSessionId = activeSession?.id ?? null;

  const { data: personas = [] } = usePersonas();
  const { data: imageAssets = [] } = useAssets("ref_image");
  const { data: audioAssets = [] } = useAssets("ref_audio");

  const createSessionMutation = useCreateSession();
  const stopSessionMutation = useStopSession();
  const updateConfigMutation = useUpdateSessionConfig();
  const uploadAssetMutation = useUploadAsset();
  const uploadSessionAssetsMutation = useUploadSessionAssets();

  const [config, setConfig] = useState<StudioConfigState>(DEFAULT_CONFIG);
  const [appliedPrompt, setAppliedPrompt] = useState("");
  const [appliedCharacterParam, setAppliedCharacterParam] = useState(false);

  // Media devices & local preview
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const engineClientRef = useRef<RealtimeSessionClient | null>(null);
  const micMonitorRef = useRef<MicLevelMonitor | null>(null);
  const outputRecorderRef = useRef<LiveOutputRecorder | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const hydratedSessionIdRef = useRef<string | null>(null);

  const [cameras, setCameras] = useState<MediaDeviceOption[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceOption[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [selectedMicId, setSelectedMicId] = useState("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");

  // Live session state
  const [sessionStatus, setSessionStatus] = useState<OrchestratedSessionStatus | null>(null);
  const [streamPhase, setStreamPhase] = useState<EngineStreamPhase>("disconnected");
  const [videoActivity, setVideoActivity] = useState<VideoActivityState>(null);
  const [videoActivityReason, setVideoActivityReason] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [speechActive, setSpeechActive] = useState(false);

  // Local toggles & recording
  const [micMuted, setMicMuted] = useState(false);
  const [camPaused, setCamPaused] = useState(false);
  const [monitorMuted, setMonitorMuted] = useState(true);
  const [viewLayout, setViewLayout] = useState<StudioViewLayout>("pip");
  const [isRecordingOutput, setIsRecordingOutput] = useState(false);
  const [recordingDurationS, setRecordingDurationS] = useState(0);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
  const [saveCharacterOpen, setSaveCharacterOpen] = useState(false);
  const [characterDraft, setCharacterDraft] = useState<Partial<CreatePersonaInput> | null>(null);

  const hasVideo = config.mode === "video" || config.mode === "both";
  const hasVoice = config.mode === "voice" || config.mode === "both";

  const hasLookInput = Boolean(config.refImageAssetId || config.prompt.trim());
  const hasVoiceInput = Boolean(config.refAudioAssetId);
  const missingLook = hasVideo && !hasLookInput;
  const missingVoice = hasVoice && !hasVoiceInput;
  const canGoLive = !missingLook && !missingVoice;
  const preflightHint =
    missingLook && missingVoice
      ? "Pick a target photo (or style) and a voice clip to go live."
      : missingLook
        ? "Pick a target photo or add a style description to go live."
        : missingVoice
          ? "Pick or record a target voice clip to go live."
          : null;

  const isStyleDirty = Boolean(activeSession) && config.prompt.trim() !== appliedPrompt.trim();

  const isControllable =
    Boolean(activeSessionId) &&
    (sessionStatus === "ready" ||
      sessionStatus === "active" ||
      sessionStatus === "disconnect_grace");
  const { data: engineStatus } = useSessionEngineStatus(activeSessionId, isControllable);

  // Keep latest values in refs so the SSE/WS lifecycle effect never tears down on toggles/keystrokes
  const activeSessionRef = useRef<SessionDetail | null>(activeSession ?? null);
  activeSessionRef.current = activeSession ?? null;

  const configRef = useRef(config);
  configRef.current = config;

  const mediaStateRef = useRef({
    micMuted,
    camPaused,
    monitorMuted,
    selectedMicId,
    selectedSpeakerId,
  });
  mediaStateRef.current = {
    micMuted,
    camPaused,
    monitorMuted,
    selectedMicId,
    selectedSpeakerId,
  };

  const patchConfig = useCallback((patch: Partial<StudioConfigState>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  // Enumerate connected media devices on mount
  useEffect(() => {
    void enumerateMediaDevices().then((devs) => {
      setCameras(devs.cameras);
      setMicrophones(devs.microphones);
      setSpeakers(devs.speakers);
      if (devs.cameras[0]) setSelectedCameraId((prev) => prev || devs.cameras[0]!.deviceId);
      if (devs.microphones[0]) setSelectedMicId((prev) => prev || devs.microphones[0]!.deviceId);
      if (devs.speakers[0]) setSelectedSpeakerId((prev) => prev || devs.speakers[0]!.deviceId);
    });
  }, []);

  // Apply ?characterId= (or ?personaId=) once characters load (when no active session)
  useEffect(() => {
    if (
      appliedCharacterParam ||
      !initialCharacterParam ||
      activeSessionId ||
      personas.length === 0
    ) {
      return;
    }
    const found = personas.find((p) => p.id === initialCharacterParam);
    if (found) {
      patchConfig({
        mode: modeFromModalities(found.modalities),
        personaId: found.id,
        prompt: found.prompt ?? "",
        refImageAssetId: found.refImageAssetId ?? "",
        refAudioAssetId: found.refAudioAssetId ?? "",
      });
      setAppliedPrompt(found.prompt ?? "");
      setAppliedCharacterParam(true);
    }
  }, [appliedCharacterParam, initialCharacterParam, activeSessionId, personas, patchConfig]);

  // Hydrate character assets when reconnecting to an active session on page load
  useEffect(() => {
    if (!activeSession || !activeSession.personaId || personas.length === 0) return;
    if (hydratedSessionIdRef.current === activeSession.id) return;
    const found = personas.find((p) => p.id === activeSession.personaId);
    if (found) {
      const curr = configRef.current;
      patchConfig({
        personaId: found.id,
        prompt: curr.prompt || found.prompt || "",
        refImageAssetId: curr.refImageAssetId || found.refImageAssetId || "",
        refAudioAssetId: curr.refAudioAssetId || found.refAudioAssetId || "",
      });
      if (!curr.prompt && found.prompt) {
        setAppliedPrompt(found.prompt);
      }
      hydratedSessionIdRef.current = activeSession.id;
    }
  }, [activeSession, personas, patchConfig]);

  // Manage local webcam preview stream when video modality is selected
  useEffect(() => {
    let cancelled = false;

    async function startPreview() {
      if (!hasVideo) {
        if (localStreamRef.current) {
          for (const t of localStreamRef.current.getTracks()) t.stop();
          localStreamRef.current = null;
        }
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: selectedCameraId ? { deviceId: { exact: selectedCameraId } } : true,
        });
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        if (localStreamRef.current) {
          for (const t of localStreamRef.current.getTracks()) t.stop();
        }
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          await localVideoRef.current.play().catch(() => {});
        }
        const devs = await enumerateMediaDevices();
        setCameras(devs.cameras);
        setMicrophones(devs.microphones);
        setSpeakers(devs.speakers);
      } catch (err) {
        if (!cancelled) {
          setErrorBanner(
            formatFriendlyError(
              err,
              "Please allow camera access in your browser to preview your video.",
            ),
          );
        }
      }
    }

    void startPreview();

    return () => {
      cancelled = true;
    };
  }, [hasVideo, selectedCameraId]);

  // Pre-launch microphone level meter preview
  useEffect(() => {
    if (activeSessionId || !hasVoice || micMuted) {
      micMonitorRef.current?.stop();
      micMonitorRef.current = null;
      if (!activeSessionId) setInputLevel(0);
      return;
    }

    const monitor = new MicLevelMonitor();
    micMonitorRef.current = monitor;
    void monitor.start(selectedMicId || undefined, setInputLevel).catch(() => {});

    return () => {
      monitor.stop();
      if (micMonitorRef.current === monitor) {
        micMonitorRef.current = null;
      }
    };
  }, [activeSessionId, hasVoice, micMuted, selectedMicId]);

  const stopOutputRecordingCleanup = useCallback(() => {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    outputRecorderRef.current?.cancel();
    outputRecorderRef.current = null;
    setIsRecordingOutput(false);
    setRecordingDurationS(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopOutputRecordingCleanup();
      micMonitorRef.current?.stop();
      engineClientRef.current?.stop();
      if (localStreamRef.current) {
        for (const t of localStreamRef.current.getTracks()) t.stop();
      }
    };
  }, [stopOutputRecordingCleanup]);

  const connectEngine = useCallback(async (session: SessionDetail) => {
    if (engineClientRef.current) return;
    micMonitorRef.current?.stop();
    micMonitorRef.current = null;

    const c = configRef.current;
    const m = mediaStateRef.current;

    const client = new RealtimeSessionClient(session, {
      onPhaseChange: setStreamPhase,
      onVideoActivityChange: (activity, reason) => {
        setVideoActivity(activity);
        setVideoActivityReason(reason ?? null);
      },
      onInputLevel: setInputLevel,
      onOutputLevel: setOutputLevel,
      onSpeechActive: setSpeechActive,
      onError: (msg) =>
        setErrorBanner(
          formatFriendlyError(msg, "Your live connection was interrupted. Please try again."),
        ),
      onStopped: () => {
        engineClientRef.current = null;
        setStreamPhase("disconnected");
      },
    });
    engineClientRef.current = client;

    try {
      await client.connect({
        videoEl: localVideoRef.current,
        renderCanvas: outputCanvasRef.current,
        micDeviceId: m.selectedMicId || undefined,
        speakerDeviceId: m.selectedSpeakerId || undefined,
        micMuted: m.micMuted,
        camPaused: m.camPaused,
        monitorMuted: m.monitorMuted,
        preferredVideoCodec: "mjpeg",
        initialOverrides: {
          prompt: session.modalities.includes("video") ? c.prompt.trim() || null : null,
        },
      });
    } catch (err) {
      engineClientRef.current = null;
      setStreamPhase("error");
      setErrorBanner(
        formatFriendlyError(err, "Could not connect to your live studio. Please try again."),
      );
    }
  }, []);

  // Key SSE + WS management strictly on activeSessionId (no teardown on toggles/refetch)
  useEffect(() => {
    const session = activeSessionRef.current;
    if (!activeSessionId || !session) {
      hydratedSessionIdRef.current = null;
      setSessionStatus(null);
      setVideoActivity(null);
      setVideoActivityReason(null);
      stopOutputRecordingCleanup();
      if (engineClientRef.current) {
        engineClientRef.current.stop();
        engineClientRef.current = null;
      }
      return;
    }

    setSessionStatus(session.status);

    const curr = configRef.current;
    const sessionPrompt = session.initialConfig.prompt ?? "";
    patchConfig({
      mode: modeFromModalities(session.modalities),
      ...(session.personaId && !curr.personaId ? { personaId: session.personaId } : {}),
      ...(!curr.prompt && sessionPrompt ? { prompt: sessionPrompt } : {}),
    });
    if (!curr.prompt && sessionPrompt) {
      setAppliedPrompt(sessionPrompt);
    }

    if (
      session.status === "ready" ||
      session.status === "active" ||
      session.status === "disconnect_grace"
    ) {
      void connectEngine(session);
    }

    const unsubscribe = subscribeSessionEvents(
      activeSessionId,
      (ev) => {
        if (ev.type === "session_status") {
          setSessionStatus(ev.status);
          if ((ev.status === "ready" || ev.status === "active") && !engineClientRef.current) {
            void getSession(activeSessionId).then((fresh) => {
              qc.setQueryData(queryKeys.activeSession, fresh);
              void connectEngine(fresh);
            });
          }
          if (TERMINAL_SESSION_STATUSES.has(ev.status)) {
            stopOutputRecordingCleanup();
            engineClientRef.current?.stop();
            engineClientRef.current = null;
            qc.setQueryData(queryKeys.activeSession, null);
          }
        } else if (ev.type === "session_ready") {
          setSessionStatus(ev.status);
          if (!engineClientRef.current) {
            void getSession(activeSessionId).then((fresh) => {
              qc.setQueryData(queryKeys.activeSession, fresh);
              void connectEngine(fresh);
            });
          }
        } else if (ev.type === "session_stopped") {
          stopOutputRecordingCleanup();
          engineClientRef.current?.stop();
          engineClientRef.current = null;
          setSessionStatus("stopped");
          qc.setQueryData(queryKeys.activeSession, null);
        } else if (ev.type === "session_failed") {
          stopOutputRecordingCleanup();
          engineClientRef.current?.stop();
          engineClientRef.current = null;
          setSessionStatus("failed");
          setErrorBanner(
            formatFriendlyError(
              ev.reason,
              "Your live session ended unexpectedly. Please try starting again.",
            ),
          );
          qc.setQueryData(queryKeys.activeSession, null);
        }
      },
      () => {
        // EventSource auto-reconnects on transient drops
      },
    );

    return () => {
      unsubscribe();
    };
  }, [activeSessionId, connectEngine, patchConfig, qc, stopOutputRecordingCleanup]);

  async function handleStartSession() {
    if (!canGoLive) return;
    setErrorBanner(null);
    setNoticeBanner(null);
    const modalities = modalitiesFromMode(config.mode);

    try {
      await createSessionMutation.mutateAsync({
        modalities,
        quality: "standard",
        ...(config.personaId ? { personaId: config.personaId } : {}),
        ...(hasVideo && config.prompt.trim() ? { prompt: config.prompt.trim() } : {}),
        ...(hasVideo && config.refImageAssetId ? { refImageAssetId: config.refImageAssetId } : {}),
        ...(hasVoice && config.refAudioAssetId ? { refAudioAssetId: config.refAudioAssetId } : {}),
      });
      setAppliedPrompt(hasVideo ? config.prompt.trim() : "");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.existingSessionId) {
        try {
          const existing = await getSession(err.existingSessionId);
          qc.setQueryData(queryKeys.activeSession, existing);
          setNoticeBanner("Reconnected to your live session.");
          return;
        } catch {
          // fall through to display friendly error
        }
      }
      setErrorBanner(
        formatFriendlyError(err, "Could not start your live studio. Please try again."),
      );
    }
  }

  async function handleStopSession() {
    if (!activeSession) return;
    setErrorBanner(null);
    setNoticeBanner(null);
    stopOutputRecordingCleanup();
    engineClientRef.current?.stop();
    engineClientRef.current = null;
    try {
      await stopSessionMutation.mutateAsync(activeSession.id);
    } catch (err) {
      setErrorBanner(formatFriendlyError(err, "Could not end the session. Please try again."));
    }
  }

  async function handleSelectCharacter(characterId: string) {
    if (!characterId) {
      patchConfig({ personaId: "" });
      return;
    }
    const found = personas.find((p) => p.id === characterId);
    if (!found) return;

    if (!activeSession) {
      const nextMode = characterSupportsMode(found, config.mode)
        ? config.mode
        : modeFromModalities(found.modalities);
      patchConfig({
        mode: nextMode,
        personaId: found.id,
        prompt: found.prompt ?? "",
        refImageAssetId: found.refImageAssetId ?? "",
        refAudioAssetId: found.refAudioAssetId ?? "",
      });
      setAppliedPrompt(found.prompt ?? "");
      return;
    }

    if (!isCharacterCompatibleWithMode(found, config.mode)) {
      return;
    }

    const applyLook = hasVideo && characterSupportsMode(found, "video");

    patchConfig({
      personaId: found.id,
      ...(applyLook
        ? {
            prompt: found.prompt ?? "",
            refImageAssetId: found.refImageAssetId ?? "",
          }
        : {}),
      ...(hasVoice && found.refAudioAssetId ? { refAudioAssetId: found.refAudioAssetId } : {}),
    });
    if (applyLook) {
      setAppliedPrompt(found.prompt ?? "");
    }

    if (isControllable) {
      setErrorBanner(null);
      try {
        await updateConfigMutation.mutateAsync({
          id: activeSession.id,
          body: {
            ...(applyLook
              ? {
                  prompt: found.prompt ?? null,
                  ...(found.refImageAssetId
                    ? { refImageAssetId: found.refImageAssetId }
                    : { clearRefImage: true }),
                }
              : {}),
            ...(hasVoice && found.refAudioAssetId
              ? { refAudioAssetId: found.refAudioAssetId }
              : {}),
          },
        });
      } catch (err) {
        setErrorBanner(
          formatFriendlyError(err, "Could not switch character right now. Please try again."),
        );
      }
    }
  }

  async function handleApplyPrompt(promptOverride?: string) {
    const nextPrompt = (promptOverride ?? config.prompt).trim();
    if (!activeSession || !isControllable) return;
    setErrorBanner(null);
    try {
      await updateConfigMutation.mutateAsync({
        id: activeSession.id,
        body: { prompt: nextPrompt },
      });
      setAppliedPrompt(nextPrompt);
    } catch (err) {
      setErrorBanner(formatFriendlyError(err, "Could not update your look. Please try again."));
    }
  }

  function handlePickStyleSuggestion(value: string) {
    patchConfig({ prompt: value, personaId: "" });
    if (activeSession && isControllable) {
      void handleApplyPrompt(value);
    }
  }

  async function handleClearRefImage() {
    patchConfig({ refImageAssetId: "", personaId: "" });
    if (!activeSession || !isControllable) return;
    setErrorBanner(null);
    try {
      await updateConfigMutation.mutateAsync({
        id: activeSession.id,
        body: { clearRefImage: true },
      });
    } catch (err) {
      setErrorBanner(formatFriendlyError(err, "Could not clear the photo. Please try again."));
    }
  }

  async function handleSelectRefImageAsset(assetId: string) {
    patchConfig({ refImageAssetId: assetId, personaId: "" });
    if (!activeSession || !isControllable) return;
    setErrorBanner(null);
    try {
      await updateConfigMutation.mutateAsync({
        id: activeSession.id,
        body: assetId ? { refImageAssetId: assetId } : { clearRefImage: true },
      });
    } catch (err) {
      setErrorBanner(formatFriendlyError(err, "Could not switch the photo. Please try again."));
    }
  }

  async function handleSelectRefAudioAsset(assetId: string) {
    patchConfig({ refAudioAssetId: assetId, personaId: "" });
    if (!activeSession || !isControllable || !assetId) return;
    setErrorBanner(null);
    try {
      await updateConfigMutation.mutateAsync({
        id: activeSession.id,
        body: { refAudioAssetId: assetId },
      });
    } catch (err) {
      setErrorBanner(
        formatFriendlyError(err, "Could not switch the voice clip. Please try again."),
      );
    }
  }

  async function handleUploadRefImage(file: File) {
    setErrorBanner(null);
    try {
      const asset = await uploadAssetMutation.mutateAsync({
        kind: "ref_image",
        name: file.name,
        file,
      });
      patchConfig({ refImageAssetId: asset.id, personaId: "" });
      if (activeSession && isControllable) {
        try {
          await updateConfigMutation.mutateAsync({
            id: activeSession.id,
            body: { refImageAssetId: asset.id },
          });
        } catch (err) {
          if (isAssetFetchFallbackError(err)) {
            const form = new FormData();
            form.append("ref_image", file);
            await uploadSessionAssetsMutation.mutateAsync({
              id: activeSession.id,
              formData: form,
            });
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      setErrorBanner(formatFriendlyError(err, "Could not upload that photo. Please try again."));
    }
  }

  async function handleCaptureWebcamSnapshot() {
    if (!localVideoRef.current) return;
    setErrorBanner(null);
    try {
      const file = await captureWebcamSnapshot(localVideoRef.current);
      await handleUploadRefImage(file);
    } catch (err) {
      setErrorBanner(
        formatFriendlyError(err, "Could not take a photo from your camera. Please try again."),
      );
    }
  }

  async function handleUploadRefAudio(file: File) {
    setErrorBanner(null);
    try {
      const asset = await uploadAssetMutation.mutateAsync({
        kind: "ref_audio",
        name: file.name,
        file,
      });
      patchConfig({ refAudioAssetId: asset.id, personaId: "" });
      if (activeSession && isControllable) {
        try {
          await updateConfigMutation.mutateAsync({
            id: activeSession.id,
            body: { refAudioAssetId: asset.id },
          });
        } catch (err) {
          if (isAssetFetchFallbackError(err)) {
            const form = new FormData();
            form.append("ref_audio", file);
            await uploadSessionAssetsMutation.mutateAsync({
              id: activeSession.id,
              formData: form,
            });
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      setErrorBanner(
        formatFriendlyError(err, "Could not upload that voice clip. Please try again."),
      );
    }
  }

  function handleClearRefAudio() {
    patchConfig({ refAudioAssetId: "", personaId: "" });
  }

  async function handleToggleRecordOutput() {
    if (isRecordingOutput && outputRecorderRef.current) {
      try {
        const { blob, filename } = await outputRecorderRef.current.stop();
        stopOutputRecordingCleanup();
        downloadBlob(blob, filename);
      } catch (err) {
        stopOutputRecordingCleanup();
        setErrorBanner(
          formatFriendlyError(err, "Could not save your recorded clip. Please try again."),
        );
      }
      return;
    }

    setErrorBanner(null);
    const recorder = new LiveOutputRecorder();
    try {
      recorder.start({
        canvas: hasVideo ? outputCanvasRef.current : null,
        audioStream: hasVoice ? engineClientRef.current?.getOutputAudioStream() : null,
        fps: 24,
      });
      outputRecorderRef.current = recorder;
      setIsRecordingOutput(true);
      setRecordingDurationS(0);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingDurationS((s) => s + 1);
      }, 1_000);
    } catch (err) {
      setErrorBanner(formatFriendlyError(err, "Could not start recording. Please try again."));
    }
  }

  async function handleCaptureOutputSnapshot() {
    if (!outputCanvasRef.current) return;
    setErrorBanner(null);
    try {
      const file = await captureCanvasSnapshot(outputCanvasRef.current);
      downloadBlob(file, file.name);
    } catch (err) {
      setErrorBanner(formatFriendlyError(err, "Could not save a snapshot yet. Try again."));
    }
  }

  function handleOpenSaveCharacter() {
    const modalities = modalitiesFromMode(config.mode);
    setCharacterDraft({
      name: "",
      modalities,
      prompt: hasVideo ? config.prompt.trim() || null : null,
      refImageAssetId: hasVideo ? config.refImageAssetId || null : null,
      refAudioAssetId: hasVoice ? config.refAudioAssetId || null : null,
      videoConfig: null,
      audioConfig: null,
    });
    setSaveCharacterOpen(true);
  }

  return (
    <div className="flex flex-col gap-6">
      {noticeBanner ? (
        <Alert>
          <AlertDescription>{noticeBanner}</AlertDescription>
        </Alert>
      ) : null}

      {errorBanner ? (
        <Alert variant="destructive">
          <AlertDescription>{errorBanner}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <StudioStage
          localVideoRef={localVideoRef}
          outputCanvasRef={outputCanvasRef}
          hasVideo={hasVideo}
          hasVoice={hasVoice}
          activeSession={activeSession ?? null}
          sessionStatus={sessionStatus}
          engineStatus={engineStatus ?? null}
          streamPhase={streamPhase}
          videoActivity={videoActivity}
          videoActivityReason={videoActivityReason}
          inputLevel={inputLevel}
          outputLevel={outputLevel}
          speechActive={speechActive}
          micMuted={micMuted}
          camPaused={camPaused}
          monitorMuted={monitorMuted}
          viewLayout={viewLayout}
          isRecordingOutput={isRecordingOutput}
          recordingDurationS={recordingDurationS}
          cameras={cameras}
          microphones={microphones}
          speakers={speakers}
          selectedCameraId={selectedCameraId}
          selectedMicId={selectedMicId}
          selectedSpeakerId={selectedSpeakerId}
          isStarting={createSessionMutation.isPending}
          isStopping={stopSessionMutation.isPending}
          canGoLive={canGoLive}
          preflightHint={preflightHint}
          onToggleMicMuted={() => {
            const next = !micMuted;
            setMicMuted(next);
            engineClientRef.current?.setMicMuted(next);
          }}
          onToggleCamPaused={() => {
            const next = !camPaused;
            setCamPaused(next);
            engineClientRef.current?.setCamPaused(next);
          }}
          onToggleMonitorMuted={() => {
            const next = !monitorMuted;
            setMonitorMuted(next);
            engineClientRef.current?.setMonitorMuted(next);
          }}
          onToggleViewLayout={() => setViewLayout((prev) => (prev === "pip" ? "split" : "pip"))}
          onToggleRecordOutput={() => void handleToggleRecordOutput()}
          onCaptureOutputSnapshot={() => void handleCaptureOutputSnapshot()}
          onSelectCamera={setSelectedCameraId}
          onSelectMic={(id) => {
            setSelectedMicId(id);
            void engineClientRef.current?.setMicDevice(id || undefined);
          }}
          onSelectSpeaker={(id) => {
            setSelectedSpeakerId(id);
            void engineClientRef.current?.setSpeakerDevice(id);
          }}
          onStartSession={() => void handleStartSession()}
          onStopSession={() => void handleStopSession()}
        />

        <StudioControls
          config={config}
          isSessionActive={Boolean(activeSession)}
          isApplyingConfig={updateConfigMutation.isPending}
          isUploadingAsset={uploadAssetMutation.isPending || uploadSessionAssetsMutation.isPending}
          isStyleDirty={isStyleDirty}
          personas={personas}
          imageAssets={imageAssets}
          audioAssets={audioAssets}
          selectedMicId={selectedMicId}
          onChange={patchConfig}
          onSelectCharacter={(id) => void handleSelectCharacter(id)}
          onApplyPrompt={() => void handleApplyPrompt()}
          onPickStyleSuggestion={handlePickStyleSuggestion}
          onClearRefImage={() => void handleClearRefImage()}
          onUploadRefImage={handleUploadRefImage}
          onCaptureWebcamSnapshot={handleCaptureWebcamSnapshot}
          onUploadRefAudio={handleUploadRefAudio}
          onClearRefAudio={handleClearRefAudio}
          onSelectRefImageAsset={(id) => void handleSelectRefImageAsset(id)}
          onSelectRefAudioAsset={(id) => void handleSelectRefAudioAsset(id)}
          onSaveAsCharacter={handleOpenSaveCharacter}
        />
      </div>

      <CharacterDialog
        open={saveCharacterOpen}
        onOpenChange={setSaveCharacterOpen}
        editingCharacter={null}
        initialDraft={characterDraft}
        onSaved={(saved) => {
          patchConfig({ personaId: saved.id });
          setNoticeBanner(`Saved character "${saved.name}".`);
        }}
      />
    </div>
  );
}
