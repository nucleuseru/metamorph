import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ConfigProvider, Effect, Exit, Layer } from "effect";

import { ObjectStorage } from "./services/storage.ts";

describe("ObjectStorage.layer", () => {
  test("fails when S3_BUCKET is unset", async () => {
    const exit = await Effect.runPromiseExit(
      ObjectStorage.useSync((s) => s).pipe(
        Effect.provide(
          ObjectStorage.layer.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          ),
        ),
      ),
    );
    assert.equal(Exit.isFailure(exit), true);
  });

  test("fails when S3_BUCKET is empty", async () => {
    const exit = await Effect.runPromiseExit(
      ObjectStorage.useSync((s) => s).pipe(
        Effect.provide(
          ObjectStorage.layer.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ S3_BUCKET: "   " }))),
          ),
        ),
      ),
    );
    assert.equal(Exit.isFailure(exit), true);
  });

  test("configures s3 backend when S3_BUCKET is set", async () => {
    const storage = await Effect.runPromise(
      Effect.scoped(
        ObjectStorage.useSync((s) => s).pipe(
          Effect.provide(
            ObjectStorage.layer.pipe(
              Layer.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    S3_BUCKET: "test-bucket",
                    S3_REGION: "us-east-1",
                    AWS_ACCESS_KEY_ID: "test",
                    AWS_SECRET_ACCESS_KEY: "test",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    assert.equal(storage.backend, "s3");
  });
});
