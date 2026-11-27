import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import {
  CodePipeline,
  CodePipelineSource,
  ManualApprovalStep,
  ShellStep,
} from "aws-cdk-lib/pipelines";
import { Construct } from "constructs";

import { AppStage } from "./app-stage";
import { config, type StageName } from "./config";

interface EnvPipelineProps extends cdk.StackProps {
  branchName: string;
  environmentName: StageName;
}

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EnvPipelineProps) {
    super(scope, id, props);

    const pipeline = new CodePipeline(this, `Pipeline-${props.environmentName}`, {
      pipelineName: `Pipeline-${props.environmentName}`,
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
          computeType: codebuild.ComputeType.SMALL,
        },
      },
      synth: new ShellStep("Synth", {
        input: CodePipelineSource.connection(config.repo, props.branchName, {
          connectionArn: `arn:aws:codeconnections:${config.region}:${config.account}:connection/${config.codeConnectionId}`,
        }),
        commands: [
          "corepack enable",
          "pnpm install --frozen-lockfile --filter @metamorph/infra...",
          "pnpm --filter @metamorph/infra build",
          "pnpm --filter @metamorph/infra cdk synth",
        ],
        primaryOutputDirectory: "apps/infra/cdk.out",
      }),
    });

    const appStage = new AppStage(this, props.environmentName, {
      env: props.env,
      stageName: props.environmentName,
    });

    const preSteps =
      props.environmentName === "production"
        ? [
            new ManualApprovalStep("PromoteToProduction", {
              comment: "Approve deployment to production",
            }),
          ]
        : undefined;

    const postSteps = [
      new ShellStep("SmokeTest", {
        envFromCfnOutputs: {
          API_PUBLIC_URL: appStage.apiPublicUrlOutput,
        },
        commands: ['curl -fsS --max-time 15 --retry 3 --retry-delay 5 "${API_PUBLIC_URL}/health"'],
      }),
    ];

    pipeline.addStage(appStage, {
      pre: preSteps,
      post: postSteps,
    });
  }
}
