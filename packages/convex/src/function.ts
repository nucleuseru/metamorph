import {
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { ConvexError } from "convex/values";
import {
  query,
  internalMutation as rawInternalMutation,
  mutation as rawMutation,
} from "./_generated/server";
import { authComponent, createAuth } from "./betterAuth/auth";
import { triggers } from "./triggers";

export const mutation = customMutation(rawMutation, customCtx(triggers.wrapDB));
export const internalMutation = customMutation(
  rawInternalMutation,
  customCtx(triggers.wrapDB),
);

export const authQuery = customQuery(
  query,
  customCtx(async (ctx) => {
    const { auth, headers } = await authComponent.getAuth(createAuth, ctx);
    const session = await auth.api.getSession({ headers });

    if (!session) {
      throw new ConvexError("Unauthorized");
    }

    return { ...session, headers, auth };
  }),
);

export const authMutation = customMutation(
  mutation,
  customCtx(async (ctx) => {
    const { auth, headers } = await authComponent.getAuth(createAuth, ctx);
    const session = await auth.api.getSession({ headers });

    if (!session) {
      throw new ConvexError("Unauthorized");
    }

    return { ...session, headers, auth };
  }),
);
