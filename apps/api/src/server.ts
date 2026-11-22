import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api";
import { createServer } from "node:http";
import { Api } from "./api.ts";

const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  Effect.succeed(
    handlers.handleAll({
      health: () => Effect.succeed({ status: "ok" as const }),
    }),
  ),
);

const ApiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: "/openapi.json",
}).pipe(Layer.provide(SystemHandlers));

const DocsRoute = HttpApiScalar.layer(Api, {
  path: "/docs",
});

const AllRoutes = Layer.mergeAll(ApiRoutes, DocsRoute);

export const HttpServerLayer = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const port = yield* Config.Int("PORT").pipe(Config.withDefault(3001));
        return NodeHttpServer.layer(createServer, { port });
      }),
    ),
  ),
);
