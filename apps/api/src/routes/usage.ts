import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Api } from "../api/index.ts";
import { CurrentSession } from "../middleware/auth.ts";
import { UsageRepository } from "../repositories/index.ts";

export const UsageHandlers = HttpApiBuilder.group(
  Api,
  "usage",
  Effect.fn(function* (handlers) {
    const usage = yield* UsageRepository;
    return handlers.handleAll({
      summary: () =>
        Effect.gen(function* () {
          const { user } = yield* CurrentSession;
          return yield* usage.getSummary(user.id).pipe(Effect.orDie);
        }),
    });
  }),
);
