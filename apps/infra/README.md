# Metamorph Infrastructure (`@metamorph/infra`)

AWS CDK infrastructure for `@metamorph/api` with two self-mutating CodePipeline pipelines:

- `Pipeline-Development` (`development` branch)
- `Pipeline-Production` (`main` branch, with manual approval gate)

## Architecture (Cost-Effective)

- **NetworkStack**: VPC with 2 AZs, `0` NAT Gateways ($0/mo), Public + Isolated subnets, and an S3 Gateway VPC Endpoint.
- **StorageStack**: Private S3 bucket (`S3_MANAGED` encryption, SSL enforced, multipart abort lifecycle).
- **DatabaseStack**: RDS PostgreSQL 17 on `db.t4g.micro` in an isolated subnet (`gp3`, encrypted).
- **ComputeStack**: `t4g.small` ARM64 EC2 instance with Elastic IP, Nginx + Docker blue-green zero-downtime deploys via SSM, and a CloudFront distribution (`PriceClass_100`, `REDIRECT_TO_HTTPS`) providing free AWS-managed HTTPS (`https://<id>.cloudfront.net`) without requiring a custom domain.

## Configuration

Set environment variables (or update defaults in `lib/config.ts`):

- `CDK_ACCOUNT` / `CDK_DEFAULT_ACCOUNT`: Target AWS account ID
- `CDK_REGION` / `CDK_DEFAULT_REGION`: Target AWS region (default: `eu-north-1`)
- `CODE_CONNECTION_ID`: AWS CodeConnections connection UUID for GitHub (`nucleuseru/metamorph`)
- `ALERT_EMAIL`: Optional email address for CloudWatch / EC2 recovery SNS alerts
- `DEV_CLIENT_ORIGIN` / `PROD_CLIENT_ORIGIN`: Allowed CORS/Better Auth origins

Runtime application secrets are read from AWS Secrets Manager at `metamorph/api/secrets/development` and `metamorph/api/secrets/production` (e.g. `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RUNPOD_API_KEY`, `VASTAI_API_KEY`, `ENGINE_JWT_PRIVATE_KEY`).

## Commands

Run from the repository root:

```bash
pnpm --filter @metamorph/infra typecheck
pnpm --filter @metamorph/infra test
pnpm --filter @metamorph/infra cdk synth
```
