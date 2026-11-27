import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { AuthMiddleware } from "../middleware/auth.ts";

const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
});

const CurrentUserResponse = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  emailVerified: Schema.Boolean,
  image: Schema.NullOr(Schema.String),
});

const PublicJwkEntry = Schema.Struct({
  kty: Schema.String,
  crv: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  kid: Schema.optionalKey(Schema.String),
  alg: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
});

const EngineJwksResponse = Schema.Struct({
  keys: Schema.Array(PublicJwkEntry),
});

export class SystemGroup extends HttpApiGroup.make("system", { topLevel: true })
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: HealthResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("engineJwks", "/.well-known/engine-jwks.json", {
      success: EngineJwksResponse,
    }),
  ) {}

export class AccountGroup extends HttpApiGroup.make("account", { topLevel: true })
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: CurrentUserResponse,
    }),
  )
  .middleware(AuthMiddleware) {}
