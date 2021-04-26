# AWS CDK AWS Transfer SFTP Server Demo

This Javascript CDK project creates an AWS Transfer SFTP Server with test users and S3 notifications.

<img src="lib/assets/aws-transfer-diagram.png" width="1000">

&nbsp;

The SFTP server can optionally use a custom hostname and certificate, or you can test using the default server name.

This Readme assumes you already have an understanding of CDK deployments.

You can deploy the stacks using CDK Deploy.

&nbsp;

## Requirements

- The demo uses the AWS default VPC by default, but you can also use your own. The VPC must have public subnets.
- Route53 domain if you want to use a custom hostname. The Route53 Zone must be in the same Account.

&nbsp;

## Setup

Assuming you have the AWS CLI and CDK installed and configured already...

Setup the project:
- Clone the repo
- run `npm install`
- Update the `lib/application/options.json` file with your own environment details and preferences

&nbsp;

## Options

- vpcId - leave blank to use the default VPC, or enter your own VPC Id.
- customHostname - use a custom domain and hostname for the server. If true you will also need to enter the hostname and hostedZoneId for the Route53 zone.
- certificateArn - we can create a new certificate for the custom hostname, or you can use an existing certificate.
- users - enter at least one user so you can test the server. You will need to create a public/private key pair and copy the public key here. On Windows copy the public key from the PuttyGen window, the format in the saved text files won't work.
- notificationEmails - enter an email address here if you want to test notifications. You will receive a verification notice from SNS on deployment.

&nbsp;

## Deployment

Use CDK to deploy:
`cdk deploy`

Note we are using Lookups for the VPC and domain here. You will need to be authenticated to the correct Account in the CLI before you can run `cdk diff` or `cdk synth` the first time. After that the VPC info is saved in cdk.context and you can run offline.

&nbsp;


## Testing and Updating

The server hostname will be Output on deployment and available publicly.

The server is also connected to the VPC for internal use but that is more complicated to access and test - you can look up the DNS address on the VPC Endpoint (a network load balancer is required if you want a friendly hostname internally - a project for later).

Use your favourite SFTP client to upload some files. You should see them moved almost instantly from the upload bucket to the archive bucket.

&nbsp;

## Costs and Cleanup

AWS Transfer is expensive at ~$200/month - don't leave it running after testing!

Use `cdk destroy` or delete the CloudFormation stacks.

Note the S3 buckets won't be deleted unless you delete the objects in them manually first.