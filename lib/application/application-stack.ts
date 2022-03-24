/* eslint-disable no-multi-str */
/* eslint-disable no-template-curly-in-string */
/* eslint-disable no-new */

import {
    Stack, CfnOutput, RemovalPolicy, Duration, CustomResource, StackProps,
} from 'aws-cdk-lib';
import { CfnServer, CfnUser } from 'aws-cdk-lib/aws-transfer';
import {
    Vpc, SecurityGroup, CfnEIP, Peer, Port,
} from 'aws-cdk-lib/aws-ec2';
import { HostedZone, CnameRecord, IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Certificate, CertificateValidation, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Role, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, BlockPublicAccess, EventType } from 'aws-cdk-lib/aws-s3';
import { SnsDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription, LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { options } from '../../config';

/**
 * Deploys an AWS Transfer Server with optional custom hostname and certificate.
 * User(s) are created with SSH key authentication.
 * S3 notifications are sent to SNS on new file upload, which triggers email
 * notifications and a Lambda archive function.
 * An optional custom Lambda resource can import a custom Host key for the server.
 *
 * @param {Construct} scope
 * @param {string} id
 * @param {StackProps=} props
 */
export class ApplicationStack extends Stack {
    zone?: IHostedZone;

    certificate?: ICertificate | Certificate;

    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        const {
            vpcAttr, sftpAttr, customHostKey, customHostname, users, notificationEmails,
        } = options;
        const { customVpcId } = vpcAttr;
        const { allowCidrs, moveToArchive } = sftpAttr;
        const {
            useCustomHostname, dnsAttr, sftpHostname, certificateArn,
        } = customHostname;
        const { useCustomKey, hostKeySecretArn, hostKeyVersion } = customHostKey;

        // VPC Setup =========================================================================================================

        // Use an existing VPC if specified in options, or the default VPC if not
        const vpc = (customVpcId) ? Vpc.fromLookup(this, 'vpc', { vpcId: customVpcId }) : Vpc.fromLookup(this, 'vpc', { isDefault: true });
        const { vpcId, vpcCidrBlock } = vpc;

        // Get public subnets from the VPC and confirm we have at least one
        const subnets = vpc.publicSubnets;
        if (!subnets.length) { throw new Error('We need at least one public subnet in the VPC'); }
        const subnetIds = subnets.map((subnet) => subnet.subnetId);

        // Server Resources ==================================================================================================

        // DNS Custom host
        if (useCustomHostname) {
            const { zoneName, hostedZoneId } = dnsAttr;
            if (!zoneName || !hostedZoneId || !sftpHostname) { throw new Error('zoneName, hostedZoneId, sftpHostname are required to use a custom hostname'); }
            this.zone = HostedZone.fromHostedZoneAttributes(this, 'zone', dnsAttr);

            // Certificate for custom hostname
            // Creating a certificate if an existing Certificate has not been provided.
            // Will try to create auth records in the Route53 DNS zone, which must be in the same account.
            this.certificate = (certificateArn) ? Certificate.fromCertificateArn(this, 'cert', certificateArn) : new Certificate(this, 'cert', {
                domainName: `*.${zoneName}`,
                validation: CertificateValidation.fromDns(this.zone),
            });
        }

        // Logging Role
        const loggingRole = new Role(this, 'loggingRole', {
            assumedBy: new ServicePrincipal('transfer.amazonaws.com'),
            description: 'Logging Role for the SFTP Server',
        });
        loggingRole.addToPrincipalPolicy(new PolicyStatement({
            sid: 'Logs',
            actions: [
                'logs:CreateLogStream',
                'logs:DescribeLogStreams',
                'logs:CreateLogGroup',
                'logs:PutLogEvents',
            ],
            resources: ['*'],
        }));

        // Security Group
        const sg = new SecurityGroup(this, 'sg', {
            description: 'SFTP Server Sg',
            vpc,
            allowAllOutbound: true,
        });
        if (allowCidrs.length) {
            // allow access only from the specified Cidr ranges and internal VPC
            allowCidrs.forEach((cidr) => {
                sg.addIngressRule(Peer.ipv4(cidr), Port.tcp(22), 'allow external SFTP access');
            });
            sg.addIngressRule(Peer.ipv4(vpcCidrBlock), Port.tcp(22), 'allow internal SFTP access');
        } else {
            // or allow public access
            sg.addIngressRule(Peer.anyIpv4(), Port.tcp(22), 'allow public SFTP access');
        }

        // EIP addresses for the server. Optional, but allows for your customers/users to whitelist your server
        const addressAllocationIds = subnetIds.map((sid) => (new CfnEIP(this, `eip${sid}`)).attrAllocationId);

        // Create the SFTP server
        const server = new CfnServer(this, 'sftpServer', {
            domain: 'S3',
            endpointType: 'VPC',
            identityProviderType: 'SERVICE_MANAGED',
            loggingRole: loggingRole.roleArn,
            protocols: ['SFTP'],
            endpointDetails: {
                addressAllocationIds,
                vpcId,
                subnetIds,
                securityGroupIds: [sg.securityGroupId],
            },
            certificate: this.certificate?.certificateArn,
        });

        // Server attributes
        const serverId = server.attrServerId;
        const domainName = `${serverId}.server.transfer.${this.region}.amazonaws.com`;
        new CfnOutput(this, 'domainName', {
            description: 'Server endpoint hostname',
            value: domainName,
        });

        // DNS Host record
        if (useCustomHostname && this.zone) {
            const sftpDomainName = `${sftpHostname}.${this.zone.zoneName}`;
            new CnameRecord(this, 'record', {
                recordName: sftpDomainName,
                domainName,
                zone: this.zone,
            });
            new CfnOutput(this, 'customHostname', {
                description: 'Custom server hostname',
                value: sftpDomainName,
            });
        }

        // S3 Bucket for incoming files
        const sftpBucket = new Bucket(this, 'sftpBucket', {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Add a custom server host key if specified =======================================================================
        // The Private key must be stored base64 encoded as plan text in Secrets Manager
        if (useCustomKey) {
            if (!hostKeySecretArn) { throw new Error('hostKeySecretArn is required when importing a custom host key'); }
            // Import the SFTP Key Secret
            const keySecret = Secret.fromSecretCompleteArn(this, 'keySecret', hostKeySecretArn);
            // Lambda function for custom resource. We cannot use the CDK AWSCustomResource provider as we need to manipulate the key from Secrets Manager
            const hostKeyFnc = new Function(this, 'hostKeyFnc', {
                description: 'Update SFTP Host Key',
                runtime: Runtime.NODEJS_14_X,
                handler: 'index.handler',
                timeout: Duration.seconds(5),
                code: Code.fromAsset(`${__dirname}/lambda/host-key`),
                logRetention: RetentionDays.ONE_WEEK,
            });
            // Allow access to Secret
            keySecret.grantRead(hostKeyFnc);
            // Add policy to allow access to Transfer API
            hostKeyFnc.addToRolePolicy(new PolicyStatement({
                actions: ['transfer:UpdateServer'],
                resources: [`arn:aws:transfer:${this.region}:${this.account}:server/${serverId}`],
            }));

            // Create the CloudFormation custom provider
            const hostKeyProvider = new Provider(this, 'hostKeyProvider', {
                onEventHandler: hostKeyFnc,
                logRetention: RetentionDays.ONE_WEEK,
            });

            // Update the host key using the custom resource
            new CustomResource(this, 'customHostKey', {
                serviceToken: hostKeyProvider.serviceToken,
                properties: {
                    serverId,
                    hostKeySecretArn,
                    hostKeyVersion, // Used to trigger an update to a new key
                },
            });
        }

        // User Resources ==================================================================================================

        // Base role for Users. SFTP User policy below restricts users to their own home folder only.
        // The base role must include all permissions that will be assigned to users.
        const userRole = new Role(this, 'userRole', {
            assumedBy: new ServicePrincipal('transfer.amazonaws.com'),
            description: 'SFTP standard user role',
        });
        userRole.addToPrincipalPolicy(new PolicyStatement({
            sid: 'List',
            actions: ['s3:ListBucket'],
            resources: ['*'],
        }));
        userRole.addToPrincipalPolicy(new PolicyStatement({
            sid: 'UserObjects',
            actions: [
                's3:PutObject',
                's3:GetObject',
                's3:GetObjectVersion',
            ],
            resources: [`${sftpBucket.bucketArn}/*`],
        }));

        // Users
        users.forEach((user: { userName: string; publicKey: string; }, i) => {
            const { userName, publicKey } = user;
            new CfnUser(this, `user${i + 1}`, {
                role: userRole.roleArn,
                serverId,
                userName,
                homeDirectory: `/${sftpBucket.bucketName}/home/${userName}`,
                sshPublicKeys: [publicKey],
                policy: '{ \n\
                    "Version": "2012-10-17", \n\
                            "Statement": [ \n\
                                { \n\
                                    "Sid": "AllowListingOfUserFolder", \n\
                                    "Effect": "Allow", \n\
                                    "Action": "s3:ListBucket", \n\
                                    "Resource": "arn:aws:s3:::${transfer:HomeBucket}", \n\
                                    "Condition": { \n\
                                        "StringLike": { \n\
                                            "s3:prefix": [ \n\
                                                "home/${transfer:UserName}/*", \n\
                                                "home/${transfer:UserName}" \n\
                                            ] \n\
                                        } \n\
                                    } \n\
                                }, \n\
                                { \n\
                                    "Sid": "HomeDirObjectAccess", \n\
                                    "Effect": "Allow", \n\
                                    "Action": [ \n\
                                        "s3:PutObject", \n\
                                        "s3:GetObject", \n\
                                        "s3:GetObjectVersion" \n\
                                    ], \
                                    "Resource": "arn:aws:s3:::${transfer:HomeDirectory}*" \n\
                                } \n\
                            ] \n\
                    } \n\
                ',
            });
        });

        // Notifications ==================================================================================================
        // Create SNS Topic
        const notifTopic = new Topic(this, 'notifTopic', { displayName: 'AWS Transfer Notifictions' });

        // Add notification event to S3
        sftpBucket.addEventNotification(EventType.OBJECT_CREATED_PUT, new SnsDestination(notifTopic));

        // Add email subscribers
        notificationEmails.forEach((email: string) => {
            notifTopic.addSubscription(new EmailSubscription(email));
        });

        // Lambda Archive =================================================================================================
        if (moveToArchive) {
            // Use a Lambda function to archive files

            // S3 archive bucket
            const archiveBucket = new Bucket(this, 'archiveBucket', {
                blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
                removalPolicy: RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
            });

            // Archive function
            const archiveFnc = new Function(this, 'archiveFnc', {
                description: 'Lambda SFTP Archive Function',
                runtime: Runtime.NODEJS_14_X,
                handler: 'index.handler',
                timeout: Duration.seconds(5),
                code: Code.fromAsset(`${__dirname}/lambda/archive`),
                environment: {
                    ARCHIVE_BUCKET: archiveBucket.bucketName,
                },
            });
            archiveBucket.grantPut(archiveFnc);
            sftpBucket.grantReadWrite(archiveFnc);

            // Subscribe Lambda to the SNS topic
            notifTopic.addSubscription(new LambdaSubscription(archiveFnc));
        }
    }
}
