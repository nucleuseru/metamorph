import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";

import { AppStage } from "../lib/app-stage";
import { PipelineStack } from "../lib/pipeline-stack";

const env = { account: "123456789012", region: "eu-north-1" };

describe("Metamorph Infra", () => {
  test("Pipeline-Development and Pipeline-Production synthesize with expected approval gates", () => {
    const app = new cdk.App();

    const devPipeline = new PipelineStack(app, "Pipeline-Development", {
      env,
      branchName: "development",
      environmentName: "development",
    });

    const prodPipeline = new PipelineStack(app, "Pipeline-Production", {
      env,
      branchName: "main",
      environmentName: "production",
    });

    const devTemplate = Template.fromStack(devPipeline);
    devTemplate.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      Name: "Pipeline-development",
    });
    const devPipelines = devTemplate.findResources("AWS::CodePipeline::Pipeline");
    const devStagesJson = JSON.stringify(Object.values(devPipelines)[0]);
    expect(devStagesJson).not.toContain("PromoteToProduction");

    const prodTemplate = Template.fromStack(prodPipeline);
    prodTemplate.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      Name: "Pipeline-production",
    });
    const prodPipelines = prodTemplate.findResources("AWS::CodePipeline::Pipeline");
    const prodStagesJson = JSON.stringify(Object.values(prodPipelines)[0]);
    expect(prodStagesJson).toContain("PromoteToProduction");
  });

  test("AppStage provisions cost-effective network, storage, database, and HTTPS compute", () => {
    const app = new cdk.App();
    const stage = new AppStage(app, "development", {
      env,
      stageName: "development",
    });

    const networkStack = stage.node.findChild("NetworkStack") as cdk.Stack;
    const networkTemplate = Template.fromStack(networkStack);
    networkTemplate.resourceCountIs("AWS::EC2::NatGateway", 0);
    networkTemplate.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      VpcEndpointType: "Gateway",
    });

    const storageStack = stage.node.findChild("StorageStack") as cdk.Stack;
    const storageTemplate = Template.fromStack(storageStack);
    storageTemplate.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });

    const dbStack = stage.node.findChild("DatabaseStack") as cdk.Stack;
    const dbTemplate = Template.fromStack(dbStack);
    dbTemplate.hasResourceProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.t4g.micro",
      StorageEncrypted: true,
      DeletionProtection: false,
      DBName: "metamorph",
    });

    const computeStack = stage.node.findChild("ComputeStack") as cdk.Stack;
    const computeTemplate = Template.fromStack(computeStack);
    computeTemplate.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: "t4g.small",
      MetadataOptions: Match.objectLike({
        HttpTokens: "required",
      }),
    });
    computeTemplate.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        PriceClass: "PriceClass_100",
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
        }),
      }),
    });
  });

  test("Production stage enables RDS deletion protection and alarms", () => {
    const app = new cdk.App();
    const stage = new AppStage(app, "production", {
      env,
      stageName: "production",
    });

    const dbStack = stage.node.findChild("DatabaseStack") as cdk.Stack;
    const dbTemplate = Template.fromStack(dbStack);
    dbTemplate.hasResourceProperties("AWS::RDS::DBInstance", {
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
    });
    dbTemplate.resourceCountIs("AWS::CloudWatch::Alarm", 1);

    const computeStack = stage.node.findChild("ComputeStack") as cdk.Stack;
    const computeTemplate = Template.fromStack(computeStack);
    computeTemplate.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });
});
