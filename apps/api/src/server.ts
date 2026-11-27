import { createServer } from "node:http";

import { NodeCrypto, NodeHttpServer, NodeWS } from "@effect/platform-node";
import { ReconcilerLayer } from "@metamorph/orchestrator";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api";

import { Api } from "./api/index.ts";
import { AuthMiddlewareLayer } from "./middleware/auth.ts";
import {
  AssetRepository,
  DrizzleInstanceStoreLayer,
  PersonaRepository,
  UsageRepository,
} from "./repositories/index.ts";
import { AssetContentRoute, AssetsHandlers } from "./routes/assets.ts";
import { PersonasHandlers } from "./routes/personas.ts";
import { SessionsHandlers } from "./routes/sessions/index.ts";
import { AccountHandlers, BetterAuthRoutes, SystemHandlers } from "./routes/system.ts";
import { UsageHandlers } from "./routes/usage.ts";
import { EngineWebhookRoute } from "./routes/webhooks.ts";
import { SessionWsRelayRoute } from "./routes/ws-relay.ts";
import { Auth, TrustedOrigins } from "./services/auth.ts";
import { Database } from "./services/db.ts";
import { EngineTokenService } from "./services/engine-tokens.ts";
import { AppOrchestratorLayer } from "./services/orchestrator.ts";
import { ObjectStorage } from "./services/storage.ts";

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
