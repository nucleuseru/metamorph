import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import { Mac } from "effect/crypto";
import { Hex } from "effect/encoding";

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface PutObjectInput {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

export interface SignedUrlInput {
  readonly assetId: string;
  readonly storageKey: string;
  readonly expiresInSeconds?: number | undefined;
}

export interface VerifyLocalSignedUrlInput {
  readonly assetId: string;
  readonly expires: number;
  readonly sig: string;
}

export interface ObjectStorageShape {
  readonly backend: "s3" | "local" | "memory";
  readonly put: (input: PutObjectInput) => Effect.Effect<void, StorageError>;
  readonly get: (key: string) => Effect.Effect<StoredObject, StorageError>;
  readonly delete: (key: string) => Effect.Effect<void, StorageError>;
  readonly getSignedDownloadUrl: (input: SignedUrlInput) => Effect.Effect<string, StorageError>;
  readonly verifyLocalSignedUrl: (
    input: VerifyLocalSignedUrlInput,
  ) => Effect.Effect<boolean, StorageError>;
}

const resolveSafeLocalPath = (rootDir: string, storageKey: string): string => {
  const normalizedRoot = path.resolve(rootDir);
  const cleanKey = storageKey.replace(/^\/+/, "");
  const resolved = path.resolve(normalizedRoot, cleanKey);
  if (!resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new StorageError({ message: `Unsafe storage key path: ${storageKey}` });
  }
  return resolved;
};

const signLocalDownload = (
  mac: Mac.Mac["Service"],
  secret: string,
  assetId: string,
  expiresEpochS: number,
) =>
  Effect.gen(function* () {
    const key = yield* Mac.key(Mac.hmacSha256, new TextEncoder().encode(secret)).pipe(
      Effect.mapError((cause) => new StorageError({ message: "Failed to build HMAC key", cause })),
    );
    const payload = new TextEncoder().encode(`${assetId}:${expiresEpochS}`);
    const tag = yield* mac
      .sign(key, payload)
      .pipe(
        Effect.mapError(
          (cause) => new StorageError({ message: "Failed to sign asset URL", cause }),
        ),
      );
    return Hex.encode(tag);
  });

const verifyLocalDownload = (
  mac: Mac.Mac["Service"],
  secret: string,
  assetId: string,
  expiresEpochS: number,
  sigHex: string,
) =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    if (!Number.isInteger(expiresEpochS) || expiresEpochS < Math.floor(nowMs / 1000)) {
      return false;
    }
    const decoded = Hex.decode(sigHex.trim().toLowerCase());
    if (Result.isFailure(decoded) || decoded.success.byteLength !== 32) {
      return false;
    }
    const key = yield* Mac.key(Mac.hmacSha256, new TextEncoder().encode(secret)).pipe(
      Effect.mapError((cause) => new StorageError({ message: "Failed to build HMAC key", cause })),
    );
    const payload = new TextEncoder().encode(`${assetId}:${expiresEpochS}`);
    return yield* mac
      .verify(key, decoded.success, payload)
      .pipe(
        Effect.mapError(
          (cause) => new StorageError({ message: "Failed to verify asset URL", cause }),
        ),
      );
  });

export class ObjectStorage extends Context.Service<ObjectStorage, ObjectStorageShape>()(
  "@metamorph/api/services/ObjectStorage",
) {
  static readonly layerMemory = (options?: {
    readonly baseUrl?: string | undefined;
    readonly secret?: string | undefined;
  }) =>
    Layer.effect(
      ObjectStorage,
      Effect.gen(function* () {
        const mac = yield* Mac.Mac;
        const store = yield* Ref.make(new Map<string, StoredObject>());
        const baseUrl = (options?.baseUrl ?? "http://localhost:3001").replace(/\/+$/, "");
        const secret = options?.secret ?? "test-storage-secret-1234567890";

        return ObjectStorage.of({
          backend: "memory",
          put: (input) =>
            Ref.update(store, (map) => {
              const next = new Map(map);
              next.set(input.key, {
                bytes: new Uint8Array(input.bytes),
                contentType: input.contentType,
              });
              return next;
            }),
          get: (key) =>
            Ref.get(store).pipe(
              Effect.flatMap((map) => {
                const item = map.get(key);
                if (!item) {
                  return Effect.fail(new StorageError({ message: `Object not found: ${key}` }));
                }
                return Effect.succeed(item);
              }),
            ),
          delete: (key) =>
            Ref.update(store, (map) => {
              const next = new Map(map);
              next.delete(key);
              return next;
            }),
          getSignedDownloadUrl: ({ assetId, expiresInSeconds }) =>
            Effect.gen(function* () {
              const nowMs = yield* Clock.currentTimeMillis;
              const expires = Math.floor(nowMs / 1000) + (expiresInSeconds ?? 900);
              const sig = yield* signLocalDownload(mac, secret, assetId, expires);
              return `${baseUrl}/assets/${encodeURIComponent(assetId)}/content?expires=${expires}&sig=${sig}`;
            }),
          verifyLocalSignedUrl: ({ assetId, expires, sig }) =>
            verifyLocalDownload(mac, secret, assetId, expires, sig),
        });
      }),
    );

  static readonly layer = Layer.effect(
    ObjectStorage,
    Effect.gen(function* () {
      const mac = yield* Mac.Mac;
      const bucketOpt = yield* Config.option(Config.String("S3_BUCKET"));
      const authSecret = yield* Config.Redacted("BETTER_AUTH_SECRET");
      const apiPublicUrlOpt = yield* Config.option(Config.String("API_PUBLIC_URL"));
      const betterAuthUrl = yield* Config.String("BETTER_AUTH_URL").pipe(
        Config.withDefault("http://localhost:3001"),
      );
      const publicBaseUrl = Option.match(apiPublicUrlOpt, {
        onNone: () => betterAuthUrl,
        onSome: (v) => (v.trim() === "" ? betterAuthUrl : v.trim()),
      }).replace(/\/+$/, "");

      const bucket =
        Option.isSome(bucketOpt) && bucketOpt.value.trim() !== ""
          ? bucketOpt.value.trim()
          : undefined;

      if (bucket) {
        const region = yield* Config.String("S3_REGION").pipe(Config.withDefault("us-east-1"));
        const endpointOpt = yield* Config.option(Config.String("S3_ENDPOINT"));
        const forcePathStyle = yield* Config.Boolean("S3_FORCE_PATH_STYLE").pipe(
          Config.withDefault(false),
        );
        const profileOpt = yield* Config.option(Config.String("AWS_PROFILE"));

        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new S3Client({
                region,
                forcePathStyle,
                ...(Option.isSome(endpointOpt) && endpointOpt.value.trim() !== ""
                  ? { endpoint: endpointOpt.value.trim() }
                  : {}),
                ...(Option.isSome(profileOpt) && profileOpt.value.trim() !== ""
                  ? { profile: profileOpt.value.trim() }
                  : {}),
              }),
          ),
          (c) => Effect.sync(() => c.destroy()),
        );

        return ObjectStorage.of({
          backend: "s3",
          put: ({ key, bytes, contentType }) =>
            Effect.tryPromise({
              try: () =>
                client.send(
                  new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: bytes,
                    ContentType: contentType,
                  }),
                ),
              catch: (cause) =>
                new StorageError({ message: `S3 PutObject failed for ${key}`, cause }),
            }).pipe(Effect.asVoid),
          get: (key) =>
            Effect.tryPromise({
              try: async () => {
                const res = await client.send(
                  new GetObjectCommand({
                    Bucket: bucket,
                    Key: key,
                  }),
                );
                if (!res.Body) {
                  throw new Error(`Empty S3 body for ${key}`);
                }
                const bytes = await res.Body.transformToByteArray();
                return {
                  bytes,
                  contentType: res.ContentType,
                };
              },
              catch: (cause) =>
                new StorageError({ message: `S3 GetObject failed for ${key}`, cause }),
            }),
          delete: (key) =>
            Effect.tryPromise({
              try: () =>
                client.send(
                  new DeleteObjectCommand({
                    Bucket: bucket,
                    Key: key,
                  }),
                ),
              catch: (cause) =>
                new StorageError({ message: `S3 DeleteObject failed for ${key}`, cause }),
            }).pipe(Effect.asVoid),
          getSignedDownloadUrl: ({ storageKey, expiresInSeconds }) =>
            Effect.tryPromise({
              try: () =>
                getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: storageKey }), {
                  expiresIn: expiresInSeconds ?? 900,
                }),
              catch: (cause) =>
                new StorageError({ message: `S3 presign failed for ${storageKey}`, cause }),
            }),
          verifyLocalSignedUrl: () => Effect.succeed(false),
        });
      }

      // Local-disk ObjectStorage fallback
      const localDir = yield* Config.String("STORAGE_LOCAL_DIR").pipe(
        Config.withDefault("./data/uploads"),
      );
      const rootDir = path.resolve(localDir);
      const signingSecret = Redacted.value(authSecret);

      yield* Effect.tryPromise({
        try: () => mkdir(rootDir, { recursive: true }),
        catch: (cause) =>
          new StorageError({ message: `Failed to create local upload dir ${rootDir}`, cause }),
      });

      return ObjectStorage.of({
        backend: "local",
        put: ({ key, bytes }) =>
          Effect.tryPromise({
            try: async () => {
              const filePath = resolveSafeLocalPath(rootDir, key);
              await mkdir(path.dirname(filePath), { recursive: true });
              await writeFile(filePath, bytes);
            },
            catch: (cause) =>
              cause instanceof StorageError
                ? cause
                : new StorageError({ message: `Failed to store local object ${key}`, cause }),
          }),
        get: (key) =>
          Effect.tryPromise({
            try: async () => {
              const filePath = resolveSafeLocalPath(rootDir, key);
              const bytes = await readFile(filePath);
              return { bytes: new Uint8Array(bytes), contentType: undefined };
            },
            catch: (cause) =>
              cause instanceof StorageError
                ? cause
                : new StorageError({ message: `Failed to read local object ${key}`, cause }),
          }),
        delete: (key) =>
          Effect.tryPromise({
            try: async () => {
              const filePath = resolveSafeLocalPath(rootDir, key);
              await rm(filePath, { force: true });
            },
            catch: (cause) =>
              cause instanceof StorageError
                ? cause
                : new StorageError({ message: `Failed to delete local object ${key}`, cause }),
          }),
        getSignedDownloadUrl: ({ assetId, expiresInSeconds }) =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const expires = Math.floor(nowMs / 1000) + (expiresInSeconds ?? 900);
            const sig = yield* signLocalDownload(mac, signingSecret, assetId, expires);
            return `${publicBaseUrl}/assets/${encodeURIComponent(assetId)}/content?expires=${expires}&sig=${sig}`;
          }),
        verifyLocalSignedUrl: ({ assetId, expires, sig }) =>
          verifyLocalDownload(mac, signingSecret, assetId, expires, sig),
      });
    }),
  );
}
