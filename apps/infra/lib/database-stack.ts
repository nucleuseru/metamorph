import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

import { config, type StageName } from "./config";

interface DatabaseStackProps extends cdk.StackProps {
  stage: StageName;
  vpc: ec2.IVpc;
  alertTopic?: sns.ITopic;
}

const THREE_GIB_IN_BYTES = 3 * 1024 * 1024 * 1024;

export class DatabaseStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const isProd = props.stage === "production";

    this.database = new rds.DatabaseInstance(this, "PostgresDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorage: 20,
      maxAllocatedStorage: isProd ? 100 : 50,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: isProd ? cdk.Duration.days(14) : cdk.Duration.days(1),
      deleteAutomatedBackups: !isProd,
      deletionProtection: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.SNAPSHOT : cdk.RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
      databaseName: config.databaseName,
    });

    if (isProd) {
      const storageAlarm = new cloudwatch.Alarm(this, "DatabaseLowFreeStorageAlarm", {
        alarmDescription: "RDS PostgreSQL free storage space dropped below 3 GiB",
        metric: this.database.metricFreeStorageSpace({
          period: cdk.Duration.minutes(5),
          statistic: "Minimum",
        }),
        threshold: THREE_GIB_IN_BYTES,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      if (props.alertTopic) {
        storageAlarm.addAlarmAction(new cwActions.SnsAction(props.alertTopic));
      }
    }
  }
}
