import type {
  AssetKind,
  AudioStartConfig,
  EngineConfigUpdateResponse,
  EngineSessionStatusResponse,
  EngineWsServerMessage,
  Modality,
  OrchestratedSessionStatus,
  ProviderName,
  QualityTier,
  SessionConnectionMode,
  SessionEvent,
  VideoStartConfig,
} from "@metamorph/shared";

export type ExtendedEngineWsServerMessage =
  | EngineWsServerMessage
  | { readonly type: "pe_running"; readonly reason?: string | null }
  | {
      readonly type: "prompt_enhanced";
      readonly reason?: string | null;
      readonly enhanced_prompt?: string;
    }
  | { readonly type: "session_reset"; readonly reason?: string | null };

export function isAssetFetchFallbackError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 422 || err.status === 502);
}

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string | undefined;
  readonly existingSessionId?: string | undefined;

  constructor(
    message: string,
    status: number,
    options?: { code?: string | undefined; existingSessionId?: string | undefined },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = options?.code;
    this.existingSessionId = options?.existingSessionId;
  }
}

export interface MediaAsset {
  readonly id: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly downloadUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Persona {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly modalities: ReadonlyArray<Modality>;
  readonly prompt: string | null;
  readonly refImageAssetId: string | null;
  readonly refImageUrl: string | null;
  readonly refAudioAssetId: string | null;
  readonly refAudioUrl: string | null;
  readonly videoConfig: VideoStartConfig | null;
  readonly audioConfig: AudioStartConfig | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePersonaInput {
  readonly name: string;
  readonly description?: string | null;
  readonly modalities: ReadonlyArray<Modality>;
  readonly prompt?: string | null;
  readonly refImageAssetId?: string | null;
  readonly refAudioAssetId?: string | null;
  readonly videoConfig?: VideoStartConfig | null;
  readonly audioConfig?: AudioStartConfig | null;
}

export interface UpdatePersonaInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly modalities?: ReadonlyArray<Modality>;
  readonly prompt?: string | null;
  readonly refImageAssetId?: string | null;
  readonly refAudioAssetId?: string | null;
  readonly videoConfig?: VideoStartConfig | null;
  readonly audioConfig?: AudioStartConfig | null;
}

export interface SessionConnectionInfo {
  readonly mode: SessionConnectionMode;
  readonly wsUrl: string | null;
  readonly directWsUrl: string | null;
  readonly relayWsUrl: string;
  readonly httpUrl: string | null;
  readonly tlsSupported: boolean;
  readonly token: string | null;
  readonly tokenExpiresAt: string | null;
}

export interface SessionInitialConfig {
  readonly prompt: string | null;
  readonly refImageUrl: string | null;
  readonly refAudioUrl: string | null;
  readonly video: VideoStartConfig | null;
  readonly audio: AudioStartConfig | null;
}

export interface SessionDetail {
  readonly id: string;
  readonly userId: string;
  readonly personaId: string | null;
  readonly status: OrchestratedSessionStatus;
  readonly modalities: ReadonlyArray<Modality>;
  readonly quality: QualityTier;
  readonly provider: ProviderName;
  readonly gpuType: string;
  readonly image: string;
  readonly hourlyRateUsd: number | null;
  readonly idleTimeoutS: number;
  readonly disconnectTimeoutS: number;
  readonly maxDurationS: number;
  readonly failureReason: string | null;
  readonly activeSeconds: number;
  readonly estimatedCostUsd: number;
  readonly readyAt: string | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly connection: SessionConnectionInfo;
  readonly initialConfig: SessionInitialConfig;
}

export interface CreateSessionInput {
  readonly modalities?: ReadonlyArray<Modality>;
  readonly quality?: QualityTier;
  readonly personaId?: string;
  readonly prompt?: string;
  readonly refImageAssetId?: string;
  readonly refAudioAssetId?: string;
  readonly refImageUrl?: string;
  readonly refAudioUrl?: string;
  readonly video?: VideoStartConfig;
  readonly audio?: AudioStartConfig;
  readonly providerOverride?: ProviderName;
  readonly gpuTypeOverride?: string;
}

export interface HotSwapConfigInput {
  readonly personaId?: string;
  readonly prompt?: string | null;
  readonly refImageAssetId?: string;
  readonly refAudioAssetId?: string;
  readonly refImageUrl?: string | null;
  readonly refImageBase64?: string | null;
  readonly clearRefImage?: boolean;
  readonly refAudioUrl?: string | null;
  readonly refAudioBase64?: string | null;
  readonly video?: VideoStartConfig | null;
  readonly audio?: AudioStartConfig | null;
}

export interface SessionTokenResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly instanceId: string;
  readonly modalities: ReadonlyArray<Modality>;
}

export interface UsageBucket {
  readonly sessions: number;
  readonly activeSeconds: number;
  readonly estimatedCostUsd: number;
}

export interface UsageSummary {
  readonly totalSessions: number;
  readonly activeSessionCount: number;
  readonly totalActiveSeconds: number;
  readonly totalEstimatedCostUsd: number;
  readonly byProvider: Record<string, UsageBucket>;
  readonly byModality: Record<string, UsageBucket>;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!isFormData && init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const message =
      (typeof parsed?.message === "string" && parsed.message) ||
      (typeof parsed?.error === "string" && parsed.error) ||
      text ||
      `Request failed with status ${res.status}`;
    const rawTag = parsed ? Reflect.get(parsed, "_tag") : undefined;
    const code = typeof rawTag === "string" ? rawTag : undefined;
    const existingSessionId =
      typeof parsed?.existingSessionId === "string" ? parsed.existingSessionId : undefined;
    throw new ApiError(message, res.status, { code, existingSessionId });
  }

  return parsed as T;
}

// --- Assets ---

export async function listAssets(kind?: AssetKind): Promise<MediaAsset[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const data = await apiFetch<{ assets: MediaAsset[] }>(`/assets${query}`);
  return data.assets;
}

export async function getAsset(id: string): Promise<MediaAsset> {
  return apiFetch<MediaAsset>(`/assets/${encodeURIComponent(id)}`);
}

export async function uploadAsset(input: {
  kind: AssetKind;
  name?: string;
  file: File;
}): Promise<MediaAsset> {
  const form = new FormData();
  form.append("kind", input.kind);
  if (input.name?.trim()) {
    form.append("name", input.name.trim());
  }
  form.append("file", input.file);
  return apiFetch<MediaAsset>("/assets", {
    method: "POST",
    body: form,
  });
}

export async function deleteAsset(id: string): Promise<void> {
  await apiFetch<void>(`/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// --- Personas ---

export async function listPersonas(): Promise<Persona[]> {
  const data = await apiFetch<{ personas: Persona[] }>("/personas");
  return data.personas;
}

export async function getPersona(id: string): Promise<Persona> {
  return apiFetch<Persona>(`/personas/${encodeURIComponent(id)}`);
}

export async function createPersona(body: CreatePersonaInput): Promise<Persona> {
  return apiFetch<Persona>("/personas", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updatePersona(id: string, body: UpdatePersonaInput): Promise<Persona> {
  return apiFetch<Persona>(`/personas/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deletePersona(id: string): Promise<void> {
  await apiFetch<void>(`/personas/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// --- Sessions ---

export async function createSession(body: CreateSessionInput): Promise<SessionDetail> {
  return apiFetch<SessionDetail>("/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listSessions(params?: {
  includeEnded?: boolean;
  limit?: number;
}): Promise<SessionDetail[]> {
  const sp = new URLSearchParams();
  if (params?.includeEnded !== undefined) {
    sp.set("includeEnded", String(params.includeEnded));
  }
  if (params?.limit !== undefined) {
    sp.set("limit", String(params.limit));
  }
  const qs = sp.toString();
  const data = await apiFetch<{ sessions: SessionDetail[] }>(`/sessions${qs ? `?${qs}` : ""}`);
  return data.sessions;
}

export async function getActiveSession(): Promise<SessionDetail | null> {
  return apiFetch<SessionDetail | null>("/sessions/active");
}

export async function getSession(id: string): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
}

export async function mintSessionToken(
  id: string,
  body?: { modalities?: ReadonlyArray<Modality>; ttlSeconds?: number },
): Promise<SessionTokenResponse> {
  return apiFetch<SessionTokenResponse>(`/sessions/${encodeURIComponent(id)}/token`, {
    method: "POST",
    body: body ? JSON.stringify(body) : JSON.stringify({}),
  });
}

export async function getSessionEngineStatus(id: string): Promise<EngineSessionStatusResponse> {
  return apiFetch<EngineSessionStatusResponse>(`/sessions/${encodeURIComponent(id)}/status`);
}

export async function updateSessionConfig(
  id: string,
  body: HotSwapConfigInput,
): Promise<EngineConfigUpdateResponse> {
  return apiFetch<EngineConfigUpdateResponse>(`/sessions/${encodeURIComponent(id)}/config`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function uploadSessionAssets(
  id: string,
  formData: FormData,
): Promise<EngineConfigUpdateResponse> {
  return apiFetch<EngineConfigUpdateResponse>(`/sessions/${encodeURIComponent(id)}/assets`, {
    method: "POST",
    body: formData,
  });
}

export async function stopSession(id: string): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(`/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function subscribeSessionEvents(
  id: string,
  onEvent: (event: SessionEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const source = new EventSource(`${API_BASE_URL}/sessions/${encodeURIComponent(id)}/events`, {
    withCredentials: true,
  });

  source.addEventListener("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.data) as SessionEvent;
      onEvent(parsed);
    } catch {
      // ignore malformed keepalive/comments
    }
  });

  source.addEventListener("error", (err) => {
    onError?.(err);
  });

  return () => {
    source.close();
  };
}

// --- Usage ---

export async function getUsageSummary(): Promise<UsageSummary> {
  return apiFetch<UsageSummary>("/usage/summary");
}
