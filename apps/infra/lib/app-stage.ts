import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import { ComputeStack } from "./compute-stack";
import type { StageName } from "./config";
import { DatabaseStack } from "./database-stack";
import { NetworkStack } from "./network-stack";
import { StorageStack } from "./storage-stack";

export interface AppStageProps extends cdk.StageProps {
  stageName: StageName;
}

export class AppStage extends cdk.Stage {
  public readonly serverPublicIpOutput: cdk.CfnOutput;
  public readonly apiPublicUrlOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);

    const stage = props.stageName;
    const appSecretName = `metamorph/api/secrets/${stage}`;

    cdk.Tags.of(this).add("Environment", stage);
    cdk.Tags.of(this).add("Project", "Metamorph");

    const networkStack = new NetworkStack(this, "NetworkStack", { env: props.env });

    const storageStack = new StorageStack(this, "StorageStack", {
      env: props.env,
      stage,
    });

    const databaseStack = new DatabaseStack(this, "DatabaseStack", {
      env: props.env,
      stage,
      vpc: networkStack.vpc,
      alertTopic: networkStack.alertTopic,
    });

    const computeStack = new ComputeStack(this, "ComputeStack", {
      env: props.env,
      vpc: networkStack.vpc,
      stage,
      bucket: storageStack.bucket,
      database: databaseStack.database,
      appSecretName,
      alertTopic: networkStack.alertTopic,
    });

    this.serverPublicIpOutput = computeStack.serverPublicIpOutput;
    this.apiPublicUrlOutput = computeStack.apiPublicUrlOutput;
  }
}
