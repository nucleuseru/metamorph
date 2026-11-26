import { createServer } from "node:http";

import { NodeCrypto, NodeHttpServer, NodeWS } from "@effect/platform-node";
import { ReconcilerLayer } from "@metamorph/orchestrator";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api";

import { Api } from "./api.ts";
import { AuthMiddlewareLayer, CurrentSession } from "./middleware/auth.ts";
import { AssetContentRoute, AssetsHandlers } from "./routes/assets.ts";
import { PersonasHandlers } from "./routes/personas.ts";
import { SessionsHandlers, UsageHandlers } from "./routes/sessions.ts";
import { EngineWebhookRoute } from "./routes/webhooks.ts";
import { SessionWsRelayRoute } from "./routes/ws-relay.ts";
import { Auth, TrustedOrigins } from "./services/auth.ts";
import { Database } from "./services/db.ts";
import { EmailService } from "./services/email.ts";
import { EngineTokenService } from "./services/engine-tokens.ts";
import { AppOrchestratorLayer } from "./services/orchestrator.ts";
import {
  AssetRepository,
  DrizzleInstanceStoreLayer,
  PersonaRepository,
  UsageRepository,
} from "./services/repositories.ts";
import { ObjectStorage } from "./services/storage.ts";

const SystemHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function* (handlers) {
    const tokenService = yield* EngineTokenService;
    return handlers.handleAll({
      health: () => Effect.succeed({ status: "ok" as const }),
      engineJwks: () =>
        Effect.succeed({
          keys: tokenService.publicJwks.keys.map((k) => ({
            kty: k.kty,
            ...("crv" in k ? { crv: k.crv } : {}),
            ...("x" in k ? { x: k.x } : {}),
            ...(k.kid !== undefined ? { kid: k.kid } : {}),
            ...(k.alg !== undefined ? { alg: k.alg } : {}),
            ...(k.use !== undefined ? { use: k.use } : {}),
          })),
        }),
    });
  }),
);

const AccountHandlers = HttpApiBuilder.group(Api, "account", (handlers) =>
  Effect.succeed(
    handlers.handleAll({
      me: () =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            emailVerified: user.emailVerified,
            image: user.image ?? null,
          };
        }),
    }),
  ),
);

const ApiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: "/openapi.json",
}).pipe(
  Layer.provide(SystemHandlers),
  Layer.provide(AccountHandlers),
  Layer.provide(AssetsHandlers),
  Layer.provide(PersonasHandlers),
  Layer.provide(SessionsHandlers),
  Layer.provide(UsageHandlers),
  Layer.provide(AuthMiddlewareLayer),
);

/** Forwards `/api/auth/*` (sign-in, Google OAuth, JWT/JWKS, ...) to Better Auth. */
const BetterAuthRoutes = HttpRouter.add(
  "*",
  "/api/auth/*",
  Effect.gen(function* () {
    const auth = yield* Auth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const webResponse = yield* auth.handler(webRequest);
    return HttpServerResponse.fromWeb(webResponse);
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("Better Auth request failed", error).pipe(
        Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    ),
  ),
);

const DocsRoute = HttpApiScalar.layer(Api, {
  path: "/docs",
});

/**
 * All application routes. Leaves service dependencies (`Auth`, `EngineTokenService`,
 * `ObjectStorage`, repositories, orchestrator, and `WebSocketConstructor`) open so
 * production and tests can supply their own layers.
 */
export const AppRoutes = Layer.mergeAll(
  ApiRoutes,
  DocsRoute,
  BetterAuthRoutes,
  AssetContentRoute,
  EngineWebhookRoute,
  SessionWsRelayRoute,
);

const CorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const allowedOrigins = yield* TrustedOrigins;
    return HttpRouter.cors({
      allowedOrigins,
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    });
  }),
);

const CoreInfraLayer = Layer.mergeAll(
  NodeCrypto.layer,
  FetchHttpClient.layer,
  NodeWS.layerWebSocketConstructor,
  Database.layer,
  EmailService.layer,
);

const DomainServicesLayer = Layer.mergeAll(
  Auth.layer,
  ObjectStorage.layer,
  EngineTokenService.layer,
  AssetRepository.layer,
  PersonaRepository.layer,
  UsageRepository.layer,
  DrizzleInstanceStoreLayer,
).pipe(Layer.provideMerge(CoreInfraLayer));

const FullAppServicesLayer = AppOrchestratorLayer.pipe(Layer.provideMerge(DomainServicesLayer));

export const HttpServerLayer = HttpRouter.serve(Layer.merge(AppRoutes, CorsLayer)).pipe(
  Layer.provideMerge(ReconcilerLayer),
  Layer.provide(FullAppServicesLayer),
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const port = yield* Config.Int("PORT").pipe(Config.withDefault(3001));
        return NodeHttpServer.layer(createServer, { port });
      }),
    ),
  ),
);
