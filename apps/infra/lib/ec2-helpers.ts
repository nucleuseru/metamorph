import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

import type { StageName } from "./config";

export function resolvePinnedAl2023Arm64Ami(scope: Construct): ec2.IMachineImage {
  const machineImage = ec2.MachineImage.latestAmazonLinux2023({
    cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    cachedInContext: true,
  });

  if (
    process.env.CODEBUILD_BUILD_ID &&
    machineImage.getImage(scope).imageId.startsWith("dummy-value-for-")
  ) {
    throw new Error(
      "AMI ID is not pinned in apps/infra/cdk.context.json. Run `pnpm --filter @metamorph/infra cdk synth` locally with AWS credentials and commit apps/infra/cdk.context.json before deploying.",
    );
  }

  return machineImage;
}

export function allowTcpToTarget(
  scope: Construct,
  idPrefix: string,
  sourceSgId: string,
  targetSgId: string,
  port: number,
  description: string,
): ec2.CfnSecurityGroupIngress {
  return new ec2.CfnSecurityGroupIngress(scope, `${idPrefix}Ingress`, {
    groupId: targetSgId,
    ipProtocol: "tcp",
    fromPort: port,
    toPort: port,
    sourceSecurityGroupId: sourceSgId,
    description,
  });
}

export function addBaseBootstrapCommands(
  userData: ec2.UserData,
  opts: { swapSizeMb: number; packages: string[] },
): void {
  userData.addCommands(
    "set -euxo pipefail",
    `if [ ! -f /swapfile ]; then dd if=/dev/zero of=/swapfile bs=1M count=${opts.swapSizeMb} status=none && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && { grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab; }; fi`,
    `dnf install -y ${opts.packages.join(" ")}`,
    "mkdir -p /etc/docker",
    `cat <<'EOF' > /etc/docker/daemon.json
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF`,
    "systemctl enable --now docker",
    "usermod -aG docker ec2-user || true",
    "mkdir -p /etc/metamorph && chmod 700 /etc/metamorph",
  );
}

export function buildSsmDeployCommands(opts: {
  requiredBinaries: string[];
  stackEnvLines: string[];
  deployScriptBucket: string;
  deployScriptKey: string;
  region: string;
  imageUri: string;
}): string[] {
  const binaryChecks = opts.requiredBinaries
    .map(
      (bin) =>
        `if ! command -v ${bin} >/dev/null 2>&1; then echo "Missing binary ${bin} from UserData bootstrap" >&2; tail -n 100 /var/log/cloud-init-output.log >&2 || true; exit 1; fi`,
    )
    .join(" && ");

  return [
    "set -euo pipefail",
    'rc=0; cloud-init status --wait || rc=$?; if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then echo "cloud-init failed with exit code $rc" >&2; tail -n 100 /var/log/cloud-init-output.log >&2 || true; exit "$rc"; fi',
    binaryChecks,
    `umask 077 && cat <<'EOF' > /etc/metamorph/stack.env.tmp\n${opts.stackEnvLines.join("\n")}\nEOF\nchmod 600 /etc/metamorph/stack.env.tmp && mv /etc/metamorph/stack.env.tmp /etc/metamorph/stack.env`,
    `aws s3 cp --region "${opts.region}" "s3://${opts.deployScriptBucket}/${opts.deployScriptKey}" /usr/local/bin/deploy.sh.tmp && chmod 755 /usr/local/bin/deploy.sh.tmp && mv /usr/local/bin/deploy.sh.tmp /usr/local/bin/deploy.sh`,
    `/usr/local/bin/deploy.sh "${opts.imageUri}"`,
  ];
}

export function addEc2AutoRecoveryAlarm(
  scope: Construct,
  id: string,
  instanceId: string,
  stage: StageName,
  roleLabel: string,
  alertTopic?: sns.ITopic,
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, id, {
    alarmDescription: `Auto-recover ${stage} ${roleLabel} EC2 instance on system check failure`,
    metric: new cloudwatch.Metric({
      namespace: "AWS/EC2",
      metricName: "StatusCheckFailed_System",
      dimensionsMap: {
        InstanceId: instanceId,
      },
      statistic: "Maximum",
      period: cdk.Duration.minutes(1),
    }),
    threshold: 1,
    evaluationPeriods: 2,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.MISSING,
  });

  alarm.addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.RECOVER));
  if (alertTopic) {
    alarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
  }

  return alarm;
}
