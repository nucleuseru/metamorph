import { HttpApi, OpenApi } from "effect/http-api";

import { AssetsGroup } from "./assets.ts";
import { PersonasGroup } from "./personas.ts";
import { SessionsGroup } from "./sessions.ts";
import { AccountGroup, SystemGroup } from "./system.ts";
import { UsageGroup } from "./usage.ts";

export {
  BadGateway,
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  PayloadTooLarge,
  ServiceUnavailable,
  UnprocessableEntity,
} from "./errors.ts";
export type { MediaAssetResponse } from "./assets.ts";
export type { PersonaResponse } from "./personas.ts";
export type { SessionDetailResponse } from "./sessions.ts";

export class Api extends HttpApi.make("metamorph-api")
  .add(SystemGroup)
  .add(AccountGroup)
  .add(AssetsGroup)
  .add(PersonasGroup)
  .add(SessionsGroup)
  .add(UsageGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Metamorph API",
      version: "0.2.0",
    }),
  ) {}
