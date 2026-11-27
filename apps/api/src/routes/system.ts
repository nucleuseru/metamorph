import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Api } from "../api/index.ts";
import { CurrentSession } from "../middleware/auth.ts";
import { Auth } from "../services/auth.ts";
import { EngineTokenService } from "../services/engine-tokens.ts";

export const SystemHandlers = HttpApiBuilder.group(
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

export const AccountHandlers = HttpApiBuilder.group(Api, "account", (handlers) =>
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

/** Forwards `/api/auth/*` (sign-in, Google OAuth, JWT/JWKS, ...) to Better Auth. */
export const BetterAuthRoutes = HttpRouter.add(
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
