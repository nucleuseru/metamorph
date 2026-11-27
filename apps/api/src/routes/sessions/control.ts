import { EngineClient, OrchestratorEventBus } from "@metamorph/orchestrator";
import { TERMINAL_SESSION_STATUSES, type SessionConfigPatch } from "@metamorph/shared";
import { Effect, Stream } from "effect";
import type { HttpApiBuilder } from "effect/http-api";

import { BadRequest, Conflict, Forbidden, NotFound, PayloadTooLarge } from "../../api/index.ts";
import type { SessionsGroup } from "../../api/sessions.ts";
import { CurrentSession } from "../../middleware/auth.ts";
import { PersonaRepository } from "../../repositories/index.ts";
import { EngineTokenService } from "../../services/engine-tokens.ts";
import { mapMultipartError } from "../helpers.ts";
import { mapEngineClientError, type SessionHelpers } from "./helpers.ts";

const MAX_REF_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REF_AUDIO_BYTES = 25 * 1024 * 1024;

type LifecycleHandled = "create" | "list" | "active" | "get" | "stop" | "events";

export const makeSessionControlHandlers = <R>(
  handlers: HttpApiBuilder.Handlers<R, typeof SessionsGroup.endpoints, LifecycleHandled>,
  helpers: SessionHelpers,
) =>
  Effect.gen(function* () {
    const engineClient = yield* EngineClient;
    const eventBus = yield* OrchestratorEventBus;
    const tokenService = yield* EngineTokenService;
    const personas = yield* PersonaRepository;

    const { resolveSignedAssetUrl, getOwnedSession, getControllableSession, mintShortLivedToken } =
      helpers;

    return handlers
      .handle("mintToken", ({ params, payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const found = yield* getOwnedSession(params.id, user.id);

          if (TERMINAL_SESSION_STATUSES.has(found.status) || found.status === "stopping") {
            return yield* new Conflict({
              message: `Cannot mint token for session '${found.id}' in status '${found.status}'.`,
            });
          }

          const requestedModalities = payload?.modalities ?? found.modalities;
          for (const mod of requestedModalities) {
            if (!found.modalities.includes(mod)) {
              return yield* new Forbidden({
                message: `Modality '${mod}' is not enabled on session '${found.id}'.`,
              });
            }
          }

          if (
            payload?.ttlSeconds !== undefined &&
            (payload.ttlSeconds < 60 || payload.ttlSeconds > 3600)
          ) {
            return yield* new BadRequest({
              message: "ttlSeconds must be between 60 and 3600 seconds.",
            });
          }

          return yield* tokenService
            .mintSessionToken({
              userId: user.id,
              instanceId: found.id,
              modalities: requestedModalities,
              ttlSeconds: payload?.ttlSeconds,
            })
            .pipe(Effect.orDie);
        }),
      )
      .handle("engineStatus", ({ params }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const ready = yield* getControllableSession(params.id, user.id);
          const { token } = yield* mintShortLivedToken(user.id, ready);

          return yield* engineClient
            .getStatus(ready.httpUrl, ready.id, token)
            .pipe(Effect.mapError(mapEngineClientError));
        }),
      )
      .handle("updateConfig", ({ params, payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const ready = yield* getControllableSession(params.id, user.id);

          const personaRecord = payload.personaId
            ? yield* personas.getByIdForUser(payload.personaId, user.id).pipe(Effect.orDie)
            : null;
          if (payload.personaId && !personaRecord) {
            return yield* new NotFound({
              message: `Persona '${payload.personaId}' not found.`,
            });
          }

          const hasVideo = ready.modalities.includes("video");
          const hasVoice = ready.modalities.includes("voice");

          const effectiveRefImageAssetId =
            payload.refImageAssetId !== undefined
              ? payload.refImageAssetId
              : hasVideo &&
                  !payload.clearRefImage &&
                  payload.refImageUrl === undefined &&
                  payload.refImageBase64 === undefined
                ? personaRecord?.refImageAssetId
                : null;
          const effectiveRefAudioAssetId =
            payload.refAudioAssetId !== undefined
              ? payload.refAudioAssetId
              : hasVoice &&
                  payload.refAudioUrl === undefined &&
                  payload.refAudioBase64 === undefined
                ? personaRecord?.refAudioAssetId
                : null;

          const [signedImgUrl, signedAudUrl] = yield* Effect.all([
            resolveSignedAssetUrl(user.id, effectiveRefImageAssetId, "ref_image"),
            resolveSignedAssetUrl(user.id, effectiveRefAudioAssetId, "ref_audio"),
          ]);

          const patchPrompt =
            payload.prompt !== undefined
              ? payload.prompt
              : hasVideo
                ? (personaRecord?.prompt ?? undefined)
                : undefined;
          const patchRefImageUrl =
            payload.refImageUrl !== undefined ? payload.refImageUrl : (signedImgUrl ?? undefined);
          const patchRefAudioUrl =
            payload.refAudioUrl !== undefined ? payload.refAudioUrl : (signedAudUrl ?? undefined);
          const patchVideo =
            payload.video !== undefined
              ? payload.video
              : hasVideo
                ? (personaRecord?.videoConfig ?? undefined)
                : undefined;
          const patchAudio =
            payload.audio !== undefined
              ? payload.audio
              : hasVoice
                ? (personaRecord?.audioConfig ?? undefined)
                : undefined;

          const patch: SessionConfigPatch = {
            ...(patchPrompt !== undefined ? { prompt: patchPrompt } : {}),
            ...(patchRefImageUrl !== undefined ? { ref_image_url: patchRefImageUrl } : {}),
            ...(payload.refImageBase64 !== undefined
              ? { ref_image_base64: payload.refImageBase64 }
              : {}),
            ...(payload.clearRefImage !== undefined
              ? { clear_ref_image: payload.clearRefImage }
              : {}),
            ...(patchRefAudioUrl !== undefined ? { ref_audio_url: patchRefAudioUrl } : {}),
            ...(payload.refAudioBase64 !== undefined
              ? { ref_audio_base64: payload.refAudioBase64 }
              : {}),
            ...(patchVideo !== undefined ? { video: patchVideo } : {}),
            ...(patchAudio !== undefined ? { audio: patchAudio } : {}),
          };

          const { token } = yield* mintShortLivedToken(user.id, ready);

          const res = yield* engineClient
            .updateConfig(ready.httpUrl, ready.id, token, patch)
            .pipe(Effect.mapError(mapEngineClientError));

          yield* eventBus.publish({
            type: "session_config_updated",
            sessionId: ready.id,
            result: res,
            timestamp: new Date().toISOString(),
          });

          return res;
        }),
      )
      .handle("uploadAssets", ({ params, payload }) =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          const ready = yield* getControllableSession(params.id, user.id);

          let prompt: string | undefined;
          let clearRefImage: boolean | undefined;
          let refImage:
            | { readonly bytes: Uint8Array; readonly filename: string; readonly mimeType: string }
            | undefined;
          let refAudio:
            | { readonly bytes: Uint8Array; readonly filename: string; readonly mimeType: string }
            | undefined;

          yield* Stream.runForEach(payload, (part) =>
            Effect.gen(function* () {
              if (part._tag === "Field") {
                if (part.key === "prompt") prompt = part.value;
                if (part.key === "clear_ref_image") {
                  clearRefImage = part.value.trim().toLowerCase() === "true";
                }
                return;
              }
              if (part.key === "ref_image") {
                const bytes = yield* part.contentEffect;
                refImage = { bytes, filename: part.name, mimeType: part.contentType };
              } else if (part.key === "ref_audio") {
                const bytes = yield* part.contentEffect;
                refAudio = { bytes, filename: part.name, mimeType: part.contentType };
              }
            }),
          ).pipe(Effect.mapError((err) => mapMultipartError(err, "Upload too large")));

          if (refImage && refImage.bytes.byteLength > MAX_REF_IMAGE_BYTES) {
            return yield* new PayloadTooLarge({
              message: `ref_image exceeds ${MAX_REF_IMAGE_BYTES} bytes.`,
            });
          }
          if (refAudio && refAudio.bytes.byteLength > MAX_REF_AUDIO_BYTES) {
            return yield* new PayloadTooLarge({
              message: `ref_audio exceeds ${MAX_REF_AUDIO_BYTES} bytes.`,
            });
          }

          const { token } = yield* mintShortLivedToken(user.id, ready);

          const res = yield* engineClient
            .uploadAssets(ready.httpUrl, ready.id, token, {
              prompt,
              clearRefImage,
              refImage,
              refAudio,
            })
            .pipe(Effect.mapError(mapEngineClientError));

          yield* eventBus.publish({
            type: "session_config_updated",
            sessionId: ready.id,
            result: res,
            timestamp: new Date().toISOString(),
          });

          return res;
        }),
      );
  });
