import {
  EngineConfigUpdateResponse,
  EngineHealthResponse,
  EngineReadyResponse,
  EngineSessionStatusResponse,
  EngineShutdownResponse,
  type SessionConfigPatch,
} from "@metamorph/shared";
import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { EngineClientError } from "./errors.ts";

export interface EngineAssetUploadInput {
  readonly prompt?: string | undefined;
  readonly clearRefImage?: boolean | undefined;
  readonly refImage?:
    | { readonly bytes: Uint8Array; readonly filename: string; readonly mimeType: string }
    | undefined;
  readonly refAudio?:
    | { readonly bytes: Uint8Array; readonly filename: string; readonly mimeType: string }
    | undefined;
}

export interface EngineClientShape {
  readonly health: (
    baseUrl: string,
    instanceId: string,
  ) => Effect.Effect<EngineHealthResponse, EngineClientError>;
  readonly ready: (
    baseUrl: string,
    instanceId: string,
  ) => Effect.Effect<
    { readonly ready: boolean; readonly response: EngineReadyResponse },
    EngineClientError
  >;
  readonly getStatus: (
    baseUrl: string,
    instanceId: string,
    token: string,
  ) => Effect.Effect<EngineSessionStatusResponse, EngineClientError>;
  readonly updateConfig: (
    baseUrl: string,
    instanceId: string,
    token: string,
    patch: SessionConfigPatch,
  ) => Effect.Effect<EngineConfigUpdateResponse, EngineClientError>;
  readonly uploadAssets: (
    baseUrl: string,
    instanceId: string,
    token: string,
    input: EngineAssetUploadInput,
  ) => Effect.Effect<EngineConfigUpdateResponse, EngineClientError>;
  readonly shutdown: (
    baseUrl: string,
    instanceId: string,
    token: string,
  ) => Effect.Effect<EngineShutdownResponse, EngineClientError>;
}

const decodeHealth = Schema.decodeUnknownEffect(EngineHealthResponse);
const decodeReady = Schema.decodeUnknownEffect(EngineReadyResponse);
const decodeStatus = Schema.decodeUnknownEffect(EngineSessionStatusResponse);
const decodeConfigUpdate = Schema.decodeUnknownEffect(EngineConfigUpdateResponse);
const decodeShutdown = Schema.decodeUnknownEffect(EngineShutdownResponse);

const decodeJsonResponse = <A>(
  instanceId: string,
  path: string,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
) =>
  Effect.fnUntraced(function* (
    response: import("effect/http/HttpClientResponse").HttpClientResponse,
  ) {
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new EngineClientError({
        instanceId,
        status: response.status,
        message: `Engine ${path} returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
      });
    }
    const json = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new EngineClientError({
            instanceId,
            status: response.status,
            message: `Invalid JSON from engine ${path}`,
            cause,
          }),
      ),
    );
    return yield* decode(json).pipe(
      Effect.mapError(
        (cause) =>
          new EngineClientError({
            instanceId,
            status: response.status,
            message: `Unexpected payload from engine ${path}: ${cause.message}`,
            cause,
          }),
      ),
    );
  });

export class EngineClient extends Context.Service<EngineClient, EngineClientShape>()(
  "@metamorph/orchestrator/EngineClient",
) {
  static readonly layer = Layer.effect(
    EngineClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      const execute = Effect.fnUntraced(function* (
        instanceId: string,
        path: string,
        req: HttpClientRequest.HttpClientRequest,
      ) {
        return yield* http.execute(req).pipe(
          Effect.mapError(
            (cause) =>
              new EngineClientError({
                instanceId,
                message: `Engine request ${path} failed: ${cause.message}`,
                cause,
              }),
          ),
        );
      });

      const health: EngineClientShape["health"] = Effect.fn("EngineClient.health")(function* (
        baseUrl: string,
        instanceId: string,
      ) {
        const clean = baseUrl.replace(/\/+$/, "");
        const resp = yield* execute(
          instanceId,
          "/health",
          HttpClientRequest.get(`${clean}/health`),
        );
        return yield* decodeJsonResponse(instanceId, "/health", decodeHealth)(resp);
      });

      const ready: EngineClientShape["ready"] = Effect.fn("EngineClient.ready")(function* (
        baseUrl: string,
        instanceId: string,
      ) {
        const clean = baseUrl.replace(/\/+$/, "");
        const resp = yield* execute(instanceId, "/ready", HttpClientRequest.get(`${clean}/ready`));
        if (resp.status !== 200 && resp.status !== 503) {
          const text = yield* resp.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new EngineClientError({
            instanceId,
            status: resp.status,
            message: `Engine /ready returned HTTP ${resp.status}${text ? `: ${text}` : ""}`,
          });
        }
        const json = yield* resp.json.pipe(
          Effect.mapError(
            (cause) =>
              new EngineClientError({
                instanceId,
                status: resp.status,
                message: "Invalid JSON from engine /ready",
                cause,
              }),
          ),
        );
        const parsed = yield* decodeReady(json).pipe(
          Effect.mapError(
            (cause) =>
              new EngineClientError({
                instanceId,
                status: resp.status,
                message: `Invalid /ready schema: ${cause.message}`,
                cause,
              }),
          ),
        );
        return {
          ready: resp.status === 200 && parsed.status === "ready",
          response: parsed,
        };
      });

      const getStatus: EngineClientShape["getStatus"] = Effect.fn("EngineClient.getStatus")(
        function* (baseUrl: string, instanceId: string, token: string) {
          const clean = baseUrl.replace(/\/+$/, "");
          const req = HttpClientRequest.get(`${clean}/session/status`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.acceptJson,
          );
          const resp = yield* execute(instanceId, "/session/status", req);
          return yield* decodeJsonResponse(instanceId, "/session/status", decodeStatus)(resp);
        },
      );

      const updateConfig: EngineClientShape["updateConfig"] = Effect.fn(
        "EngineClient.updateConfig",
      )(function* (baseUrl: string, instanceId: string, token: string, patch: SessionConfigPatch) {
        const clean = baseUrl.replace(/\/+$/, "");
        const req = HttpClientRequest.post(`${clean}/session/config`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe(patch),
        );
        const resp = yield* execute(instanceId, "/session/config", req);
        return yield* decodeJsonResponse(instanceId, "/session/config", decodeConfigUpdate)(resp);
      });

      const uploadAssets: EngineClientShape["uploadAssets"] = Effect.fn(
        "EngineClient.uploadAssets",
      )(function* (
        baseUrl: string,
        instanceId: string,
        token: string,
        input: EngineAssetUploadInput,
      ) {
        const clean = baseUrl.replace(/\/+$/, "");
        const form = new FormData();
        if (input.prompt !== undefined) {
          form.set("prompt", input.prompt);
        }
        if (input.clearRefImage !== undefined) {
          form.set("clear_ref_image", input.clearRefImage ? "true" : "false");
        }
        if (input.refImage) {
          const copy = new Uint8Array(input.refImage.bytes);
          form.set(
            "ref_image",
            new Blob([copy], { type: input.refImage.mimeType }),
            input.refImage.filename,
          );
        }
        if (input.refAudio) {
          const copy = new Uint8Array(input.refAudio.bytes);
          form.set(
            "ref_audio",
            new Blob([copy], { type: input.refAudio.mimeType }),
            input.refAudio.filename,
          );
        }
        const req = HttpClientRequest.post(`${clean}/session/assets`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyFormData(form),
        );
        const resp = yield* execute(instanceId, "/session/assets", req);
        return yield* decodeJsonResponse(instanceId, "/session/assets", decodeConfigUpdate)(resp);
      });

      const shutdown: EngineClientShape["shutdown"] = Effect.fn("EngineClient.shutdown")(function* (
        baseUrl: string,
        instanceId: string,
        token: string,
      ) {
        const clean = baseUrl.replace(/\/+$/, "");
        const req = HttpClientRequest.post(`${clean}/session/shutdown`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
        );
        const resp = yield* execute(instanceId, "/session/shutdown", req);
        return yield* decodeJsonResponse(instanceId, "/session/shutdown", decodeShutdown)(resp);
      });

      return EngineClient.of({
        health,
        ready,
        getStatus,
        updateConfig,
        uploadAssets,
        shutdown,
      });
    }),
  );
}
