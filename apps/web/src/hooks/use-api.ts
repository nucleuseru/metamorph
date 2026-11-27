"use client";

import type { AssetKind } from "@metamorph/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createPersona,
  createSession,
  deleteAsset,
  deletePersona,
  getActiveSession,
  getSession,
  getSessionEngineStatus,
  getUsageSummary,
  listAssets,
  listPersonas,
  listSessions,
  stopSession,
  updatePersona,
  updateSessionConfig,
  uploadAsset,
  uploadSessionAssets,
  type CreatePersonaInput,
  type CreateSessionInput,
  type HotSwapConfigInput,
  type UpdatePersonaInput,
} from "@/lib/api-client";

export const queryKeys = {
  assets: (kind?: AssetKind) => ["assets", kind ?? "all"] as const,
  personas: ["personas"] as const,
  activeSession: ["sessions", "active"] as const,
  sessions: (includeEnded = true, limit = 50) =>
    ["sessions", "list", { includeEnded, limit }] as const,
  session: (id: string) => ["sessions", "detail", id] as const,
  sessionEngineStatus: (id: string) => ["sessions", "engine-status", id] as const,
  usage: ["usage", "summary"] as const,
};

// --- Assets ---

export function useAssets(kind?: AssetKind) {
  return useQuery({
    queryKey: queryKeys.assets(kind),
    queryFn: () => listAssets(kind),
  });
}

export function useUploadAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: uploadAsset,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
    },
  });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteAsset,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
      void qc.invalidateQueries({ queryKey: queryKeys.personas });
    },
  });
}

// --- Personas ---

export function usePersonas() {
  return useQuery({
    queryKey: queryKeys.personas,
    queryFn: listPersonas,
  });
}

export function useCreatePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePersonaInput) => createPersona(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.personas });
    },
  });
}

export function useUpdatePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdatePersonaInput }) => updatePersona(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.personas });
    },
  });
}

export function useDeletePersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deletePersona,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.personas });
    },
  });
}

// --- Sessions ---

export function useActiveSession(enabled = true) {
  return useQuery({
    queryKey: queryKeys.activeSession,
    queryFn: getActiveSession,
    enabled,
    refetchInterval: 15_000,
  });
}

export function useSessions(params?: { includeEnded?: boolean; limit?: number }) {
  const includeEnded = params?.includeEnded ?? true;
  const limit = params?.limit ?? 50;
  return useQuery({
    queryKey: queryKeys.sessions(includeEnded, limit),
    queryFn: () => listSessions({ includeEnded, limit }),
  });
}

export function useSessionDetail(id: string | null) {
  return useQuery({
    queryKey: queryKeys.session(id ?? ""),
    queryFn: () => getSession(id!),
    enabled: Boolean(id),
  });
}

export function useSessionEngineStatus(id: string | null, enabled = false) {
  return useQuery({
    queryKey: queryKeys.sessionEngineStatus(id ?? ""),
    queryFn: () => getSessionEngineStatus(id!),
    enabled: Boolean(id) && enabled,
    refetchInterval: 5_000,
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSessionInput) => createSession(body),
    onSuccess: (session) => {
      qc.setQueryData(queryKeys.activeSession, session);
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: queryKeys.usage });
    },
  });
}

export function useStopSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => stopSession(id),
    onSuccess: () => {
      qc.setQueryData(queryKeys.activeSession, null);
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: queryKeys.usage });
    },
  });
}

export function useUpdateSessionConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: HotSwapConfigInput }) =>
      updateSessionConfig(id, body),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessionEngineStatus(vars.id) });
    },
  });
}

export function useUploadSessionAssets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, formData }: { id: string; formData: FormData }) =>
      uploadSessionAssets(id, formData),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessionEngineStatus(vars.id) });
    },
  });
}

// --- Usage ---

export function useUsageSummary() {
  return useQuery({
    queryKey: queryKeys.usage,
    queryFn: getUsageSummary,
  });
}
