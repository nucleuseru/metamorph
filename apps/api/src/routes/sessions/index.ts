import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Api } from "../../api/index.ts";
import { makeSessionControlHandlers } from "./control.ts";
import { makeSessionHelpers } from "./helpers.ts";
import { makeSessionLifecycleHandlers } from "./lifecycle.ts";

export const SessionsHandlers = HttpApiBuilder.group(
  Api,
  "sessions",
  Effect.fn(function* (handlers) {
    const helpers = yield* makeSessionHelpers;
    const withLifecycle = yield* makeSessionLifecycleHandlers(handlers, helpers);
    return yield* makeSessionControlHandlers(withLifecycle, helpers);
  }),
);
