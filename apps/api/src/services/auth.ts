import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Pool } from "pg";

import { createAuth, createDrizzleDatabase, type AuthInstance, type AuthSession } from "../auth.ts";
import { EmailService } from "./email.ts";

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface AuthShape {
  readonly instance: AuthInstance;
  readonly handler: (request: Request) => Effect.Effect<Response, AuthError>;
  readonly getSession: (headers: Headers) => Effect.Effect<AuthSession | null, AuthError>;
}

export const makeAuthShape = (instance: AuthInstance): AuthShape => ({
  instance,
  handler: Effect.fn("Auth.handler")(function* (request: Request) {
    return yield* Effect.tryPromise({
      try: () => instance.handler(request),
      catch: (cause) => new AuthError({ message: "Auth handler failed", cause }),
    });
  }),
  getSession: Effect.fn("Auth.getSession")(function* (headers: Headers) {
    return yield* Effect.tryPromise({
      try: () => instance.api.getSession({ headers }),
      catch: (cause) => new AuthError({ message: "Failed to resolve session", cause }),
    });
  }),
});

export class Auth extends Context.Service<Auth, AuthShape>()("@metamorph/api/services/Auth") {
  static readonly layerFromInstance = (instance: AuthInstance) =>
    Layer.succeed(Auth, Auth.of(makeAuthShape(instance)));

  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const email = yield* EmailService;

      const databaseUrl = yield* Config.Redacted("DATABASE_URL");
      const secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
      const baseUrl = yield* Config.String("BETTER_AUTH_URL").pipe(
        Config.withDefault("http://localhost:3001"),
      );
      const trustedOrigins = yield* Config.String("BETTER_AUTH_TRUSTED_ORIGINS").pipe(
        Config.withDefault("http://localhost:3000"),
      );
      const googleClientId = yield* Config.option(Config.String("GOOGLE_CLIENT_ID"));
      const googleClientSecret = yield* Config.option(Config.Redacted("GOOGLE_CLIENT_SECRET"));
      const jwtIssuer = yield* Config.option(Config.String("JWT_ISSUER"));
      const jwtAudience = yield* Config.option(Config.String("JWT_AUDIENCE"));
      const jwtExpirationTime = yield* Config.String("JWT_EXPIRATION_TIME").pipe(
        Config.withDefault("15m"),
      );

      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: Redacted.value(databaseUrl) })),
        (p) => Effect.promise(() => p.end()),
      );

      const instance = createAuth({
        database: createDrizzleDatabase(pool),
        secret: Redacted.value(secret),
        baseUrl,
        trustedOrigins: parseOrigins(trustedOrigins),
        sendEmail: (message) => Effect.runPromise(email.send(message)),
        googleClientId: Option.getOrUndefined(googleClientId),
        googleClientSecret: Option.map(googleClientSecret, Redacted.value).pipe(
          Option.getOrUndefined,
        ),
        jwtIssuer: Option.getOrElse(jwtIssuer, () => baseUrl),
        jwtAudience: Option.getOrElse(jwtAudience, () => baseUrl),
        jwtExpirationTime,
      });

      return Auth.of(makeAuthShape(instance));
    }),
  );
}

export const parseOrigins = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

/** Origins allowed for CORS; mirrors Better Auth trusted origins. */
export const TrustedOrigins = Config.String("BETTER_AUTH_TRUSTED_ORIGINS").pipe(
  Config.withDefault("http://localhost:3000"),
  Config.map(parseOrigins),
);
