export type StageName = "development" | "production";

export const config = {
  region: process.env.CDK_REGION ?? process.env.CDK_DEFAULT_REGION!,
  account: process.env.CDK_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT!,
  databaseName: "metamorph",
  repo: "nucleuseru/metamorph",
  codeConnectionId: process.env.CODE_CONNECTION_ID!,
  clientOrigin: {
    production: process.env.PROD_CLIENT_ORIGIN!,
    development: process.env.DEV_CLIENT_ORIGIN!,
  },
  alertEmail: process.env.ALERT_EMAIL,
} as const;
