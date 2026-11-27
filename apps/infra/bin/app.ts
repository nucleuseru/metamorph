#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";

import { config } from "../lib/config";
import { PipelineStack } from "../lib/pipeline-stack";

const app = new cdk.App();

const env = {
  account: config.account,
  region: config.region,
};

// oxlint-disable-next-line eslint/no-new
new PipelineStack(app, "Pipeline-Development", {
  env,
  branchName: "development",
  environmentName: "development",
});

// oxlint-disable-next-line eslint/no-new
new PipelineStack(app, "Pipeline-Production", {
  env,
  branchName: "main",
  environmentName: "production",
});

app.synth();
