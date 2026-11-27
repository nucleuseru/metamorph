"use client";

import type { EngineSessionStatusResponse, OrchestratedSessionStatus } from "@metamorph/shared";
import {
  ArrowsSplitIcon,
  CameraIcon,
  EyeIcon,
  EyeSlashIcon,
  InfoIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PictureInPictureIcon,
  PlayIcon,
  RecordIcon,
  SlidersHorizontalIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  StopIcon,
  VideoCameraIcon,
  VideoCameraSlashIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import { useEffect, useState, type RefObject } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { SessionDetail } from "@/lib/api-client";
import type { MediaDeviceOption } from "@/lib/media/devices";
import type { EngineStreamPhase, VideoActivityState } from "@/lib/media/session-engine-client";
import { cn } from "@/lib/utils";

export type StudioViewLayout = "pip" | "split";

interface StudioStageProps {
  localVideoRef: RefObject<HTMLVideoElement | null>;
  outputCanvasRef: RefObject<HTMLCanvasElement | null>;
  hasVideo: boolean;
  hasVoice: boolean;
  activeSession: SessionDetail | null;
  sessionStatus: OrchestratedSessionStatus | null;
  engineStatus: EngineSessionStatusResponse | null;
  streamPhase: EngineStreamPhase;
  videoActivity: VideoActivityState;
  videoActivityReason: string | null;
  inputLevel: number;
  outputLevel: number;
  speechActive: boolean;
  micMuted: boolean;
  camPaused: boolean;
  monitorMuted: boolean;
  viewLayout: StudioViewLayout;
  isRecordingOutput: boolean;
  recordingDurationS: number;
  cameras: MediaDeviceOption[];
  microphones: MediaDeviceOption[];
  speakers: MediaDeviceOption[];
  selectedCameraId: string;
  selectedMicId: string;
  selectedSpeakerId: string;
  isStarting: boolean;
  isStopping: boolean;
  canGoLive: boolean;
  preflightHint: string | null;
  onToggleMicMuted: () => void;
  onToggleCamPaused: () => void;
  onToggleMonitorMuted: () => void;
  onToggleViewLayout: () => void;
  onToggleRecordOutput: () => void;
  onCaptureOutputSnapshot: () => void;
  onSelectCamera: (id: string) => void;
  onSelectMic: (id: string) => void;
  onSelectSpeaker: (id: string) => void;
  onStartSession: () => void;
  onStopSession: () => void;
}

function formatTimer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getCoachingMessage(
  activity: VideoActivityState,
  reason: string | null,
): { title: string; subtitle?: string } | null {
  if (!activity || activity === "editing") return null;
  if (activity === "pe_running") {
    return {
      title: "Polishing your look...",
      subtitle: "Getting your visual style ready.",
    };
  }
  if (activity === "session_reset") {
    return {
      title: "Welcome back — refreshing video...",
      subtitle: "Your stream will resume in a moment.",
    };
  }
  if (activity === "waiting_face") {
    if (reason === "off_center") {
      return {
        title: "Center your face on camera",
        subtitle: "Move slightly toward the middle of the frame.",
      };
    }
    if (reason === "settling") {
      return {
        title: "Hold still for a second...",
        subtitle: "Locking onto your face.",
      };
    }
    return {
      title: "Look toward your camera",
      subtitle: "Make sure your face is clearly visible.",
    };
  }
  if (activity === "no_person") {
    if (reason === "full_body_needed") {
      return {
        title: "Step back slightly",
        subtitle: "Make sure your upper body is clearly visible.",
      };
    }
    return {
      title: "Step into the camera view",
      subtitle: "Your live look will resume as soon as you're visible.",
    };
  }
  return null;
}

function getSessionReadyMessage(
  hasVideo: boolean,
  hasVoice: boolean,
): { title: string; subtitle: string } {
  if (hasVideo && hasVoice) {
    return {
      title: "Getting your studio ready...",
      subtitle: "Preparing your live look and voice. This usually takes a moment the first time.",
    };
  }
  if (hasVideo) {
    return {
      title: "Getting your look ready...",
      subtitle: "Preparing your live look. This usually takes a moment the first time.",
    };
  }
  if (hasVoice) {
    return {
      title: "Getting your voice ready...",
      subtitle: "Preparing your live voice. This usually takes a moment the first time.",
    };
  }
  return {
    title: "Getting your studio ready...",
    subtitle: "Preparing your live session. This usually takes a moment the first time.",
  };
}

export function StudioStage({
  localVideoRef,
  outputCanvasRef,
  hasVideo,
  hasVoice,
  activeSession,
  sessionStatus,
  engineStatus,
  streamPhase,
  videoActivity,
  videoActivityReason,
  inputLevel,
  outputLevel,
  speechActive,
  micMuted,
  camPaused,
  monitorMuted,
  viewLayout,
  isRecordingOutput,
  recordingDurationS,
  cameras,
  microphones,
  speakers,
  selectedCameraId,
  selectedMicId,
  selectedSpeakerId,
  isStarting,
  isStopping,
  canGoLive,
  preflightHint,
  onToggleMicMuted,
  onToggleCamPaused,
  onToggleMonitorMuted,
  onToggleViewLayout,
  onToggleRecordOutput,
  onCaptureOutputSnapshot,
  onSelectCamera,
  onSelectMic,
  onSelectSpeaker,
  onStartSession,
  onStopSession,
}: StudioStageProps) {
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [hideOverlays, setHideOverlays] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!activeSession) {
      setElapsedSeconds(0);
      return;
    }
    const createdMs = Date.parse(activeSession.createdAt);
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - createdMs) / 1000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [activeSession]);

  const isSessionLive = Boolean(activeSession);
  const isStreaming = streamPhase === "streaming";
  const isReconnecting = streamPhase === "reconnecting";
  const isCleanView = hasVideo && hideOverlays;
  const isSplitView = viewLayout === "split" && isStreaming && !isCleanView;
  const isProvisioningOrWarming =
    isSessionLive &&
    !isStreaming &&
    !isReconnecting &&
    (sessionStatus === "provisioning" ||
      sessionStatus === "warming" ||
      sessionStatus === "ready" ||
      streamPhase === "connecting" ||
      streamPhase === "authenticating" ||
      streamPhase === "starting");

  const coaching = isStreaming ? getCoachingMessage(videoActivity, videoActivityReason) : null;
  const sessionReadyMessage = getSessionReadyMessage(hasVideo, hasVoice);

  const countdownWarningS =
    engineStatus?.disconnect_countdown_s !== null &&
    engineStatus?.disconnect_countdown_s !== undefined &&
    engineStatus.disconnect_countdown_s < 60
      ? Math.ceil(engineStatus.disconnect_countdown_s)
      : engineStatus?.idle_countdown_s !== null &&
          engineStatus?.idle_countdown_s !== undefined &&
          engineStatus.idle_countdown_s < 60
        ? Math.ceil(engineStatus.idle_countdown_s)
        : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Main Stage Surface */}
      <div
        className={cn(
          "relative aspect-video w-full overflow-hidden rounded-md border border-border",
          hasVideo ? "bg-background" : "bg-card",
        )}
      >
        {/* Top Overlay Status */}
        {!isCleanView ? (
          <div className="pointer-events-none absolute top-3 right-3 left-3 z-20 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {isStreaming ? (
                <Badge variant="live" className="bg-background/95 backdrop-blur-sm">
                  <span className="size-2 animate-pulse rounded-full bg-primary" />
                  LIVE
                </Badge>
              ) : isReconnecting ? (
                <Badge variant="destructive" className="bg-background/95 backdrop-blur-sm">
                  <Spinner className="size-3" />
                  Reconnecting...
                </Badge>
              ) : isSessionLive ? (
                <Badge variant="accent" className="bg-background/95 backdrop-blur-sm">
                  <Spinner className="size-3" />
                  Getting ready...
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-background/95 backdrop-blur-sm">
                  Preview
                </Badge>
              )}

              {activeSession && isStreaming ? (
                <Badge
                  variant="outline"
                  className="bg-background/95 text-foreground tabular-nums backdrop-blur-sm"
                >
                  {formatTimer(elapsedSeconds)}
                </Badge>
              ) : null}

              {countdownWarningS !== null ? (
                <Badge variant="destructive" className="bg-background/95 backdrop-blur-sm">
                  Session pausing in {countdownWarningS}s
                </Badge>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Video + Split / PiP View */}
        {hasVideo ? (
          <div
            className={cn(
              "relative h-full w-full",
              isSplitView ? "grid grid-cols-2 gap-0.5 bg-border" : "",
            )}
          >
            {/* Transformed Output Canvas */}
            <canvas
              ref={outputCanvasRef}
              className={cn("h-full w-full bg-background object-contain", !isStreaming && "hidden")}
            />

            {/* Local Self-View Video (Full in Preview, PiP or Split when Streaming) */}
            <video
              ref={localVideoRef}
              muted
              playsInline
              autoPlay
              className={cn(
                "object-cover transition-all",
                !isStreaming
                  ? "h-full w-full"
                  : isCleanView
                    ? "pointer-events-none absolute size-px opacity-0"
                    : isSplitView
                      ? "h-full w-full bg-background"
                      : "absolute right-3 bottom-3 z-10 aspect-video w-36 rounded-md border border-border bg-background shadow-sm sm:w-48",
                camPaused && !isCleanView && "opacity-30 grayscale",
              )}
            />
          </div>
        ) : (
          /* Voice-Only Stage */
          <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-6 py-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <div
                className={cn(
                  "flex size-14 items-center justify-center rounded-full border border-border bg-surface text-foreground transition-colors",
                  speechActive && "border-primary/40 bg-accent-soft text-accent-foreground",
                )}
              >
                <WaveformIcon className="size-7" />
              </div>
              <p className="text-xl font-semibold text-foreground">
                {isStreaming ? (speechActive ? "Voice Live" : "Listening...") : "Voice Preview"}
              </p>
              <p className="text-xs font-medium text-muted-foreground">
                {monitorMuted
                  ? "Headphone preview is off to prevent echo."
                  : "Headphone preview is on — wear headphones to avoid echo."}
              </p>
            </div>

            <div className="grid w-full max-w-md grid-cols-2 gap-4">
              <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
                <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                  <span>Your Mic</span>
                  <span className="text-foreground tabular-nums">
                    {Math.round(inputLevel * 100)}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-tertiary">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-75"
                    style={{ width: `${Math.round(inputLevel * 100)}%` }}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
                <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                  <span>Transformed Voice</span>
                  <span className="text-foreground tabular-nums">
                    {Math.round(outputLevel * 100)}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-tertiary">
                  <div
                    className="h-full rounded-full bg-secondary transition-all duration-75"
                    style={{ width: `${Math.round(outputLevel * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Friendly Framing Coaching Pill */}
        {coaching && !isCleanView ? (
          <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
            <div className="flex flex-col items-center gap-0.5 rounded-md border border-border bg-background/95 px-4 py-2.5 text-center shadow-xs backdrop-blur-md">
              <span className="text-sm font-semibold text-foreground">{coaching.title}</span>
              {coaching.subtitle ? (
                <span className="text-xs font-medium text-muted-foreground">
                  {coaching.subtitle}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Calm Studio Loading Overlay */}
        {isProvisioningOrWarming && activeSession && !isCleanView ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/95 px-6 text-center backdrop-blur-md">
            <Spinner className="size-7 text-primary" />
            <h2 className="text-xl font-semibold text-foreground">{sessionReadyMessage.title}</h2>
            <p className="max-w-sm text-sm font-medium text-muted-foreground">
              {sessionReadyMessage.subtitle}
            </p>
          </div>
        ) : null}
      </div>

      {/* Bottom Media Control Bar */}
      <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label="Studio controls"
            className="flex flex-wrap items-center gap-2"
          >
            {hasVoice ? (
              <>
                <Button
                  type="button"
                  variant={micMuted ? "destructive" : "outline"}
                  size="sm"
                  onClick={onToggleMicMuted}
                >
                  {micMuted ? (
                    <MicrophoneSlashIcon data-icon="inline-start" />
                  ) : (
                    <MicrophoneIcon data-icon="inline-start" />
                  )}
                  {micMuted ? "Mic Muted" : "Mic On"}
                </Button>

                <Button
                  type="button"
                  variant={monitorMuted ? "outline" : "secondary"}
                  size="sm"
                  title="Hear your transformed voice (use headphones to avoid echo)"
                  onClick={onToggleMonitorMuted}
                >
                  {monitorMuted ? (
                    <SpeakerSlashIcon data-icon="inline-start" />
                  ) : (
                    <SpeakerHighIcon data-icon="inline-start" />
                  )}
                  {monitorMuted ? "Hear Myself" : "Hear Myself: On"}
                </Button>

                {/* Compact Mic / Voice Level Meter */}
                {hasVideo ? (
                  <div
                    aria-hidden="true"
                    className="hidden items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 sm:flex"
                  >
                    <span className="text-[10px] font-semibold text-muted-foreground">MIC</span>
                    <div className="h-1.5 w-10 overflow-hidden rounded-full bg-tertiary">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-75"
                        style={{ width: `${Math.round(inputLevel * 100)}%` }}
                      />
                    </div>
                    {isStreaming ? (
                      <>
                        <span className="ml-1 text-[10px] font-semibold text-muted-foreground">
                          OUT
                        </span>
                        <div className="h-1.5 w-10 overflow-hidden rounded-full bg-tertiary">
                          <div
                            className="h-full rounded-full bg-secondary transition-all duration-75"
                            style={{ width: `${Math.round(outputLevel * 100)}%` }}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {hasVideo ? (
              <>
                <Button
                  type="button"
                  variant={camPaused ? "destructive" : "outline"}
                  size="sm"
                  onClick={onToggleCamPaused}
                >
                  {camPaused ? (
                    <VideoCameraSlashIcon data-icon="inline-start" />
                  ) : (
                    <VideoCameraIcon data-icon="inline-start" />
                  )}
                  {camPaused ? "Camera Paused" : "Camera On"}
                </Button>

                <Button
                  type="button"
                  variant={hideOverlays ? "secondary" : "outline"}
                  size="sm"
                  title={
                    hideOverlays
                      ? "Show studio overlays and self-view"
                      : "Hide all video overlays for clean OBS capture"
                  }
                  onClick={() => setHideOverlays((prev) => !prev)}
                >
                  {hideOverlays ? (
                    <EyeIcon data-icon="inline-start" />
                  ) : (
                    <EyeSlashIcon data-icon="inline-start" />
                  )}
                  {hideOverlays ? "Show Overlays" : "Hide Overlays"}
                </Button>

                {isStreaming ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (hideOverlays) {
                          setHideOverlays(false);
                          if (viewLayout === "pip") {
                            onToggleViewLayout();
                          }
                          return;
                        }
                        onToggleViewLayout();
                      }}
                    >
                      {isSplitView ? (
                        <PictureInPictureIcon data-icon="inline-start" />
                      ) : (
                        <ArrowsSplitIcon data-icon="inline-start" />
                      )}
                      {isSplitView ? "Single View" : "Compare"}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onCaptureOutputSnapshot}
                    >
                      <CameraIcon data-icon="inline-start" />
                      Take Photo
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}

            {isStreaming ? (
              <Button
                type="button"
                variant={isRecordingOutput ? "destructive" : "outline"}
                size="sm"
                onClick={onToggleRecordOutput}
              >
                <RecordIcon
                  data-icon="inline-start"
                  className={cn(isRecordingOutput && "animate-pulse")}
                />
                {isRecordingOutput ? `Stop Rec ${formatTimer(recordingDurationS)}` : "Record Clip"}
              </Button>
            ) : null}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={devicesOpen}
              onClick={() => setDevicesOpen((o) => !o)}
            >
              <SlidersHorizontalIcon data-icon="inline-start" />
              Devices
            </Button>
          </div>

          {!isSessionLive ? (
            <Button
              type="button"
              size="lg"
              disabled={isStarting || !canGoLive}
              onClick={onStartSession}
            >
              {isStarting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {isStarting ? "Starting..." : "Go Live"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              size="lg"
              disabled={isStopping}
              onClick={onStopSession}
            >
              {isStopping ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <StopIcon data-icon="inline-start" />
              )}
              {isStopping ? "Ending..." : "End Session"}
            </Button>
          )}
        </div>

        {/* Pre-flight Guardrail Hint */}
        {!isSessionLive && !canGoLive && preflightHint ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-muted-foreground"
          >
            <InfoIcon className="size-4 shrink-0 text-accent-foreground" />
            <span>{preflightHint}</span>
          </div>
        ) : null}

        {/* Collapsible Device Pickers */}
        {devicesOpen ? (
          <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
            {hasVideo ? (
              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor="device-camera"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Camera
                </Label>
                <Select
                  id="device-camera"
                  value={selectedCameraId}
                  onChange={(e) => onSelectCamera(e.target.value)}
                >
                  {cameras.map((c) => (
                    <option key={c.deviceId} value={c.deviceId}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}

            {hasVoice ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device-mic" className="text-xs font-medium text-muted-foreground">
                    Microphone
                  </Label>
                  <Select
                    id="device-mic"
                    value={selectedMicId}
                    onChange={(e) => onSelectMic(e.target.value)}
                  >
                    {microphones.map((m) => (
                      <option key={m.deviceId} value={m.deviceId}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="device-speaker"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Speaker
                  </Label>
                  <Select
                    id="device-speaker"
                    value={selectedSpeakerId}
                    onChange={(e) => onSelectSpeaker(e.target.value)}
                  >
                    {speakers.map((s) => (
                      <option key={s.deviceId} value={s.deviceId}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
