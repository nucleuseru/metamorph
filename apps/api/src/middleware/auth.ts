import { Context, Effect, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";

import type { AuthSession } from "../auth.ts";
import { toHeaders } from "../lib/headers.ts";
import { Auth } from "../services/auth.ts";

export class CurrentSession extends Context.Service<CurrentSession, AuthSession>()(
  "@metamorph/api/middleware/CurrentSession",
) {}

class Unauthorized extends Schema.TaggedError<Unauthorized, { readonly brand: unique symbol }>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class AuthMiddleware extends HttpApiMiddleware.Service<
  AuthMiddleware,
  {
    provides: CurrentSession;
    requires: never;
  }
>()("@metamorph/api/middleware/AuthMiddleware", {
  error: Unauthorized,
}) {}

export const AuthMiddlewareLayer = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const auth = yield* Auth;

    return AuthMiddleware.of((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const headers = toHeaders(request.headers);
        const session = yield* auth
          .getSession(headers)
          .pipe(
            Effect.catchTag("AuthError", () =>
              Effect.fail(new Unauthorized({ message: "Authentication required" })),
            ),
          );
        if (session === null) {
          return yield* new Unauthorized({ message: "Authentication required" });
        }
        return yield* Effect.provideService(httpEffect, CurrentSession, session);
      }),
    );
  }),
);
