import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { AuthMiddleware } from "../middleware/auth.ts";

const UsageBucket = Schema.Struct({
  sessions: Schema.Int,
  activeSeconds: Schema.Int,
  estimatedCostUsd: Schema.Finite,
});

const UsageSummaryResponse = Schema.Struct({
  totalSessions: Schema.Int,
  activeSessionCount: Schema.Int,
  totalActiveSeconds: Schema.Int,
  totalEstimatedCostUsd: Schema.Finite,
  byProvider: Schema.Record(Schema.String, UsageBucket),
  byModality: Schema.Record(Schema.String, UsageBucket),
});

export class UsageGroup extends HttpApiGroup.make("usage")
  .add(
    HttpApiEndpoint.get("summary", "/summary", {
      success: UsageSummaryResponse,
    }),
  )
  .prefix("/usage")
  .middleware(AuthMiddleware) {}
