import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Context, Effect, Layer } from "effect";

import { relations } from "../db/schema.ts";

/** Pooled `@effect/sql-pg` client configured from `DATABASE_URL`. */
const PgClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.Redacted("DATABASE_URL");
    return PgClient.layer({ url });
  }),
);

type Db = Effect.Success<ReturnType<typeof makeDb>>;

const makeDb = () => PgDrizzle.makeWithDefaults({ relations });

/** Effect-native Drizzle database: queries are `Effect`s sharing the `PgClient` pool. */
export class Database extends Context.Service<Database, Db>()("@metamorph/api/services/Database") {
  static readonly layer = Layer.effect(Database, makeDb().pipe(Effect.map(Database.of))).pipe(
    Layer.provide(PgClientLayer),
  );
}
