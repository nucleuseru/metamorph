import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins/jwt";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { relations, schema } from "./db/schema.ts";

export interface AuthConfig {
  readonly database: BetterAuthOptions["database"];
  readonly secret: string;
  readonly baseUrl: string;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly googleClientId?: string | undefined;
  readonly googleClientSecret?: string | undefined;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly jwtExpirationTime: string;
}

export const createAuth = (config: AuthConfig) =>
  betterAuth({
    appName: "Metamorph",
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.secret,
    database: config.database,
    trustedOrigins: [...config.trustedOrigins],
    socialProviders:
      config.googleClientId && config.googleClientSecret
        ? {
            google: {
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
            },
          }
        : {},
    account: {
      encryptOAuthTokens: true,
    },
    rateLimit: {
      // In-process counters: no database round trip per request. Switch to
      // "database" or secondary storage when running multiple API replicas.
      storage: "memory",
    },
    plugins: [
      jwt({
        jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
        jwt: {
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
          expirationTime: config.jwtExpirationTime,
        },
      }),
    ],
  });

export type AuthInstance = ReturnType<typeof createAuth>;
export type AuthSession = AuthInstance["$Infer"]["Session"];

export const createDrizzleDatabase = (pool: Pool): BetterAuthOptions["database"] =>
  drizzleAdapter(drizzle({ client: pool, relations }), { provider: "pg", schema });

/**
 * Entry point for the Better Auth CLI (`pnpm auth:schema`). Reads plain
 * environment variables; the running server builds its instance in
 * `services/auth.ts` instead.
 */
export const auth = createAuth({
  database: createDrizzleDatabase(new Pool({ connectionString: process.env["DATABASE_URL"] })),
  secret: process.env["BETTER_AUTH_SECRET"] ?? "",
  baseUrl: process.env["BETTER_AUTH_URL"] ?? "http://localhost:3001",
  trustedOrigins: (process.env["BETTER_AUTH_TRUSTED_ORIGINS"] ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ""),
  googleClientId: process.env["GOOGLE_CLIENT_ID"],
  googleClientSecret: process.env["GOOGLE_CLIENT_SECRET"],
  jwtIssuer: process.env["JWT_ISSUER"] ?? process.env["BETTER_AUTH_URL"] ?? "http://localhost:3001",
  jwtAudience:
    process.env["JWT_AUDIENCE"] ?? process.env["BETTER_AUTH_URL"] ?? "http://localhost:3001",
  jwtExpirationTime: process.env["JWT_EXPIRATION_TIME"] ?? "15m",
});
