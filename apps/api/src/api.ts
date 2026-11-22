import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

export const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
});

export class SystemGroup extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", {
    success: HealthResponse,
  }),
) {}

export class Api extends HttpApi.make("metamorph-api")
  .add(SystemGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Metamorph API",
      version: "0.1.0",
    }),
  ) {}
