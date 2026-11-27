import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3Assets from "aws-cdk-lib/aws-s3-assets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import { config, type StageName } from "./config";
import {
  addBaseBootstrapCommands,
  addEc2AutoRecoveryAlarm,
  allowTcpToTarget,
  buildSsmDeployCommands,
  resolvePinnedAl2023Arm64Ami,
} from "./ec2-helpers";

interface ComputeStackProps extends cdk.StackProps {
  stage: StageName;
  vpc: ec2.IVpc;
  bucket: s3.IBucket;
  database: rds.DatabaseInstance;
  appSecretName: string;
  alertTopic?: sns.ITopic;
}

export class ComputeStack extends cdk.Stack {
  public readonly serverPublicIpOutput: cdk.CfnOutput;
  public readonly apiPublicUrlOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const isProd = props.stage === "production";
    const clientOrigin = config.clientOrigin[props.stage];
    const appSecrets = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppSecrets",
      props.appSecretName,
    );

    const appImage = new ecrAssets.DockerImageAsset(this, "ApiImage", {
      directory: path.join(__dirname, "../../.."),
      file: "apps/api/Dockerfile",
      platform: ecrAssets.Platform.LINUX_ARM64,
      ignoreMode: cdk.IgnoreMode.GLOB,
      exclude: [
        ".git",
        ".github",
        ".turbo",
        ".venv",
        ".ruff_cache",
        ".pytest_cache",
        "node_modules",
        "**/node_modules",
        "dist",
        "**/dist",
        "build",
        "**/build",
        ".next",
        "**/.next",
        "**/.env",
        "**/.env.*",
        "**/.agents",
        "**/skills-lock.json",
        "**/cdk.out",
        "apps/infra",
        "apps/web",
        "apps/engine-py",
        "packages/shared-py",
        "vendor",
        "docs",
        "pyproject.toml",
        "uv.lock",
        ".python-version",
        "apps/api/data",
      ],
    });

    const deployScript = new s3Assets.Asset(this, "DeployServerScript", {
      path: path.join(__dirname, "../scripts/deploy-server.sh"),
    });

    const logGroup = new logs.LogGroup(this, "ApiLogGroup", {
      logGroupName: `/metamorph/${props.stage}/api`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // t4g.small (2 vCPU ARM64 Graviton, 2 GiB RAM) for Effect API, WS relay, and migrations
    const serverInstance = new ec2.Instance(this, "ServerInstance", {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: resolvePinnedAl2023Arm64Ami(this),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      httpTokens: ec2.HttpTokens.REQUIRED,
      httpPutResponseHopLimit: 2,
      creditSpecification: ec2.CpuCredits.STANDARD,
      ssmSessionPermissions: true,
      userDataCausesReplacement: false,
    });

    const eip = new ec2.CfnEIP(this, "ServerEip", {
      domain: "vpc",
    });

    const eipAssociation = new ec2.CfnEIPAssociation(this, "ServerEipAssociation", {
      allocationId: eip.attrAllocationId,
      instanceId: serverInstance.instanceId,
    });

    serverInstance.connections.allowFrom(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP traffic from CloudFront to Nginx",
    );

    const serverSgId = serverInstance.connections.securityGroups[0].securityGroupId;
    const dbSgId = props.database.connections.securityGroups[0].securityGroupId;

    allowTcpToTarget(
      this,
      "ServerToDatabase",
      serverSgId,
      dbSgId,
      5432,
      "Allow API EC2 instance to reach the PostgreSQL database",
    );

    props.bucket.grantReadWrite(serverInstance.role);
    appImage.repository.grantPull(serverInstance.role);
    deployScript.grantRead(serverInstance.role);
    props.database.secret?.grantRead(serverInstance.role);
    appSecrets.grantRead(serverInstance.role);
    logGroup.grantWrite(serverInstance.role);

    const ec2DnsSuffix =
      config.region === "us-east-1"
        ? "compute-1.amazonaws.com"
        : `${config.region}.compute.amazonaws.com`;
    const originDomain = `ec2-${cdk.Fn.join("-", cdk.Fn.split(".", eip.ref))}.${ec2DnsSuffix}`;

    // CloudFront provides free AWS-managed HTTPS (*.cloudfront.net) without needing a custom domain
    const distribution = new cloudfront.Distribution(this, "ApiDistribution", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(originDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          readTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const apiPublicUrl = `https://${distribution.distributionDomainName}`;

    this.serverPublicIpOutput = new cdk.CfnOutput(this, "ServerPublicIp", { value: eip.ref });
    this.apiPublicUrlOutput = new cdk.CfnOutput(this, "ApiPublicUrl", {
      value: apiPublicUrl,
    });

    addBaseBootstrapCommands(serverInstance.userData, {
      swapSizeMb: 2048,
      packages: ["docker", "nginx", "jq", "awscli-2"],
    });

    const dbSecretArn = props.database.secret!.secretArn;
    const ecrRegistry = `${config.account}.dkr.ecr.${config.region}.amazonaws.com`;

    const deployAssociation = new ssm.CfnAssociation(this, "ServerDeployAssociation", {
      name: "AWS-RunShellScript",
      targets: [
        {
          key: "InstanceIds",
          values: [serverInstance.instanceId],
        },
      ],
      parameters: {
        commands: buildSsmDeployCommands({
          requiredBinaries: ["docker", "nginx", "jq", "aws"],
          stackEnvLines: [
            `AWS_REGION=${config.region}`,
            `ECR_REGISTRY=${ecrRegistry}`,
            `API_PUBLIC_URL=${apiPublicUrl}`,
            `BETTER_AUTH_URL=${apiPublicUrl}`,
            `BETTER_AUTH_TRUSTED_ORIGINS=${clientOrigin}`,
            `S3_BUCKET=${props.bucket.bucketName}`,
            `S3_REGION=${config.region}`,
            `DB_SECRET_ARN=${dbSecretArn}`,
            `APP_SECRET_ID=${props.appSecretName}`,
            `LOG_GROUP_NAME=${logGroup.logGroupName}`,
          ],
          deployScriptBucket: deployScript.s3BucketName,
          deployScriptKey: deployScript.s3ObjectKey,
          region: config.region,
          imageUri: appImage.imageUri,
        }),
      },
      waitForSuccessTimeoutSeconds: 900,
    });

    deployAssociation.addResourceDependency(eipAssociation);
    const defaultPolicy = serverInstance.role.node.tryFindChild("DefaultPolicy");
    if (defaultPolicy) {
      deployAssociation.node.addDependency(defaultPolicy);
    }

    addEc2AutoRecoveryAlarm(
      this,
      "ServerAutoRecoveryAlarm",
      serverInstance.instanceId,
      props.stage,
      "api",
      props.alertTopic,
    );

    if (isProd) {
      const creditAlarm = new cloudwatch.Alarm(this, "ServerLowCpuCreditsAlarm", {
        alarmDescription: "Production API t4g.small CPUCreditBalance dropped below 20",
        metric: new cloudwatch.Metric({
          namespace: "AWS/EC2",
          metricName: "CPUCreditBalance",
          dimensionsMap: {
            InstanceId: serverInstance.instanceId,
          },
          statistic: "Minimum",
          period: cdk.Duration.minutes(5),
        }),
        threshold: 20,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      if (props.alertTopic) {
        creditAlarm.addAlarmAction(new cwActions.SnsAction(props.alertTopic));
      }
    }
  }
}
