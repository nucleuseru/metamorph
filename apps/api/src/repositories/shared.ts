import { Effect, Ref, Schema } from "effect";

export class RepositoryError extends Schema.TaggedError<
  RepositoryError,
  { readonly brand: unique symbol }
>()("RepositoryError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const toRepoError = (cause: { readonly message: string }) =>
  new RepositoryError({ message: cause.message, cause });

export const firstOrNull = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<ReadonlyArray<A>, E, R>,
): Effect.Effect<A | null, RepositoryError, R> =>
  effect.pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.mapError(toRepoError),
  );

export const getForUserInMemory = <T extends { readonly userId: string }>(
  ref: Ref.Ref<Map<string, T>>,
  id: string,
  userId: string,
): Effect.Effect<T | null> =>
  Ref.get(ref).pipe(
    Effect.map((m) => {
      const found = m.get(id);
      return found && found.userId === userId ? found : null;
    }),
  );

export const listByUserInMemory = <T extends { readonly userId: string; readonly createdAt: Date }>(
  ref: Ref.Ref<Map<string, T>>,
  userId: string,
  predicate?: (record: T) => boolean,
): Effect.Effect<ReadonlyArray<T>> =>
  Ref.get(ref).pipe(
    Effect.map((m) =>
      [...m.values()]
        .filter((r) => r.userId === userId && (predicate === undefined || predicate(r)))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    ),
  );
