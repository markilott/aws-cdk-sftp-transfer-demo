/**
 * Will deploy into the current default CLI account.
 *
 * Deployment:
 * cdk deploy --all
 */

/* eslint-disable no-new */
const cdk = require('@aws-cdk/core');
const { AplicationStack } = require('../lib/application/application-stack');
const options = require('../lib/application/options.json');

const app = new cdk.App();

// use account details from default AWS CLI credentials:
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

// Create AWS Transfer stack
new AplicationStack(app, 'AwsTransferStack', {
    description: 'AWS Transfer Demo Stack',
    env: { account, region },
    options,
});
