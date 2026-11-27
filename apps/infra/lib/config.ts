export type StageName = "development" | "production";

export const config = {
  region: process.env.CDK_DEFAULT_REGION!,
  account: process.env.CDK_DEFAULT_ACCOUNT!,
  databaseName: "metamorph",
  repo: "nucleuseru/metamorph",
  codeConnectionId: "cb9ea683-0227-4931-884e-21d129faf3a6",
  clientOrigin: {
    production: "metamorph-edit.vercel.app",
    development: "metamorph-preview.vercel.app",
  },
  alertEmail: "nucleuserumagborie@gmail.com",
} as const;
