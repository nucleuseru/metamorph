import { defineRelations } from "drizzle-orm";

import * as appSchema from "./app-schema.ts";
import * as authSchema from "./auth-schema.ts";

export * from "./auth-schema.ts";
export * from "./app-schema.ts";

export const schema = {
  ...authSchema,
  ...appSchema,
};

export const relations = defineRelations(schema, (r) => ({
  user: {
    sessions: r.many.session({ from: r.user.id, to: r.session.userId }),
    accounts: r.many.account({ from: r.user.id, to: r.account.userId }),
    mediaAssets: r.many.mediaAsset({ from: r.user.id, to: r.mediaAsset.userId }),
    personas: r.many.persona({ from: r.user.id, to: r.persona.userId }),
    engineSessions: r.many.engineSession({ from: r.user.id, to: r.engineSession.userId }),
  },
  session: {
    user: r.one.user({ from: r.session.userId, to: r.user.id, optional: false }),
  },
  account: {
    user: r.one.user({ from: r.account.userId, to: r.user.id, optional: false }),
  },
  mediaAsset: {
    user: r.one.user({ from: r.mediaAsset.userId, to: r.user.id, optional: false }),
  },
  persona: {
    user: r.one.user({ from: r.persona.userId, to: r.user.id, optional: false }),
    refImageAsset: r.one.mediaAsset({
      from: r.persona.refImageAssetId,
      to: r.mediaAsset.id,
      optional: true,
    }),
    refAudioAsset: r.one.mediaAsset({
      from: r.persona.refAudioAssetId,
      to: r.mediaAsset.id,
      optional: true,
    }),
  },
  engineSession: {
    user: r.one.user({ from: r.engineSession.userId, to: r.user.id, optional: false }),
    persona: r.one.persona({
      from: r.engineSession.personaId,
      to: r.persona.id,
      optional: true,
    }),
    refImageAsset: r.one.mediaAsset({
      from: r.engineSession.refImageAssetId,
      to: r.mediaAsset.id,
      optional: true,
    }),
    refAudioAsset: r.one.mediaAsset({
      from: r.engineSession.refAudioAssetId,
      to: r.mediaAsset.id,
      optional: true,
    }),
  },
}));
