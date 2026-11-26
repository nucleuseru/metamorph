import { Schema } from "effect";

export class ProviderUnavailableError extends Schema.TaggedError<ProviderUnavailableError>()(
  "ProviderUnavailableError",
  {
    provider: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class NoCapacityError extends Schema.TaggedError<NoCapacityError>()("NoCapacityError", {
  modalities: Schema.Array(Schema.Literals(["voice", "video"])),
  quality: Schema.Literals(["standard", "high"]),
  attemptedProviders: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class InstanceNotFoundError extends Schema.TaggedError<InstanceNotFoundError>()(
  "InstanceNotFoundError",
  {
    instanceId: Schema.String,
  },
) {}

export class InstanceStateError extends Schema.TaggedError<InstanceStateError>()(
  "InstanceStateError",
  {
    instanceId: Schema.String,
    currentStatus: Schema.String,
    message: Schema.String,
  },
) {}

export class ActiveSessionConflictError extends Schema.TaggedError<ActiveSessionConflictError>()(
  "ActiveSessionConflictError",
  {
    userId: Schema.String,
    existingSessionId: Schema.String,
    message: Schema.String,
  },
) {}

export class EngineClientError extends Schema.TaggedError<EngineClientError>()(
  "EngineClientError",
  {
    instanceId: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class WebhookVerificationError extends Schema.TaggedError<WebhookVerificationError>()(
  "WebhookVerificationError",
  {
    message: Schema.String,
  },
) {}

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ModalityNotEnabledError extends Schema.TaggedError<ModalityNotEnabledError>()(
  "ModalityNotEnabledError",
  {
    modality: Schema.String,
    enabledModalities: Schema.Array(Schema.Literals(["voice", "video"])),
  },
) {}

export type OrchestratorError =
  | ProviderUnavailableError
  | NoCapacityError
  | InstanceNotFoundError
  | InstanceStateError
  | ActiveSessionConflictError
  | EngineClientError
  | WebhookVerificationError
  | StoreError
  | ModalityNotEnabledError;
