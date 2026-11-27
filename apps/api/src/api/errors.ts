import { Schema } from "effect";

export class BadRequest extends Schema.TaggedError<BadRequest, { readonly brand: unique symbol }>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden, { readonly brand: unique symbol }>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class Conflict extends Schema.TaggedError<Conflict, { readonly brand: unique symbol }>()(
  "Conflict",
  { message: Schema.String, existingSessionId: Schema.optionalKey(Schema.String) },
  { httpApiStatus: 409 },
) {}

export class PayloadTooLarge extends Schema.TaggedError<
  PayloadTooLarge,
  { readonly brand: unique symbol }
>()("PayloadTooLarge", { message: Schema.String }, { httpApiStatus: 413 }) {}

export class UnprocessableEntity extends Schema.TaggedError<
  UnprocessableEntity,
  { readonly brand: unique symbol }
>()("UnprocessableEntity", { message: Schema.String }, { httpApiStatus: 422 }) {}

export class BadGateway extends Schema.TaggedError<BadGateway, { readonly brand: unique symbol }>()(
  "BadGateway",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

export class ServiceUnavailable extends Schema.TaggedError<
  ServiceUnavailable,
  { readonly brand: unique symbol }
>()("ServiceUnavailable", { message: Schema.String }, { httpApiStatus: 503 }) {}
