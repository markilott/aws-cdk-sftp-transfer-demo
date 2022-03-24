/**
 * Will deploy into the current default CLI account.
 *
 * Deployment:
 * cdk deploy --all
 */

/* eslint-disable no-new */
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { ApplicationStack } from '../lib/application/application-stack';

const app = new App();

// use account details from default AWS CLI credentials:
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

// Create AWS Transfer stack
new ApplicationStack(app, 'AwsTransferStack', {
    description: 'AWS Transfer Demo Stack',
    env: { account, region },
});
