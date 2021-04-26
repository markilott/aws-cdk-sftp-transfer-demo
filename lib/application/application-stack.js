/* eslint-disable no-multi-str */
/* eslint-disable no-template-curly-in-string */
/* eslint-disable no-new */

const {
    Stack, CfnOutput, RemovalPolicy, Duration,
} = require('@aws-cdk/core');
const { CfnServer, CfnUser } = require('@aws-cdk/aws-transfer');
const {
    Vpc, SecurityGroup, CfnEIP, Peer, Port,
} = require('@aws-cdk/aws-ec2');
const { HostedZone, CnameRecord } = require('@aws-cdk/aws-route53');
const { Certificate, CertificateValidation } = require('@aws-cdk/aws-certificatemanager');
const { Role, PolicyStatement, ServicePrincipal } = require('@aws-cdk/aws-iam');
const { Bucket, BlockPublicAccess, EventType } = require('@aws-cdk/aws-s3');
const { SnsDestination } = require('@aws-cdk/aws-s3-notifications');
const { Topic } = require('@aws-cdk/aws-sns');
const { EmailSubscription, LambdaSubscription } = require('@aws-cdk/aws-sns-subscriptions');
const { Function, Runtime, Code } = require('@aws-cdk/aws-lambda');

class AplicationStack extends Stack {
    /**
     * Deploys an AWS Transfer Server with optional custom hostname and certificate.
     * User(s) are created with SSH key authentication.
     * S3 notifications are sent to SNS on new file upload, which triggers email
     * notifications and a Lambda archive function.
     *
     * @param {cdk.Construct} scope
     * @param {string} id
     * @param {cdk.StackProps=} props
     */
    constructor(scope, id, props) {
        super(scope, id, props);

        const { options } = props;
        const {
            vpcAttr, sftpAttr, users, notificationEmails,
        } = options;
        const { customVpcId } = vpcAttr;
        const {
            customHostname, dnsAttr, sftpHostname, allowCidr,
        } = sftpAttr;

        // VPC Setup =========================================================================================================

        // Use an existing VPC if specified in options, or the default VPC if not
        const vpc = (customVpcId) ? Vpc.fromLookup(this, 'vpc', { customVpcId }) : Vpc.fromLookup(this, 'vpc', { isDefault: true });
        const { vpcId, vpcCidrBlock } = vpc;

        // Get public subnets from the VPC and confirm we have at least one
        const subnets = vpc.publicSubnets;
        if (!subnets.length) { throw new Error('We need at least one public subnet in the VPC'); }
        const subnetIds = subnets.map((subnet) => subnet.subnetId);

        // Server Resources ==================================================================================================

        // DNS Custom host
        const { zoneName, hostedZoneId } = dnsAttr;
        if (customHostname && (!zoneName || !hostedZoneId || !sftpHostname)) { throw new Error('zoneName, hostedZoneId, sftpHostname are required to use a custom hostname'); }
        const zone = (customHostname) ? HostedZone.fromHostedZoneAttributes(this, 'zone', dnsAttr) : {};

        // Certificate for custom hostname
        let { certificateArn } = sftpAttr;
        if (customHostname) {
            // Creating a certificate if an existing Certificate has not been provided.
            // Will try to create auth records in the Route53 DNS zone, which must be in the same account.
            if (!certificateArn) {
                const cert = new Certificate(this, 'cert', {
                    domainName: `*.${zoneName}`,
                    validation: CertificateValidation.fromDns(zone),
                });
                certificateArn = cert.certificateArn;
            }
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
        if (allowCidr) {
            // allow access only from the specified Cidr range and internal VPC
            sg.addIngressRule(Peer.ipv4(allowCidr), Port.tcp(22), 'allow external SFTP access');
            sg.addIngressRule(Peer.ipv4(vpcCidrBlock), Port.tcp(22), 'allow internal SFTP access');
        } else {
            // or allow public access
            sg.addIngressRule(Peer.anyIpv4(), Port.tcp(22), 'allow public SFTP access');
        }
        const securityGroupIds = [sg.securityGroupId];

        // EIP addresses for the server. Optional, but allows for your customers/users to whitelist your server
        const addressAllocationIds = [];
        subnetIds.forEach((sid) => {
            const eip = new CfnEIP(this, `eip${sid}`);
            addressAllocationIds.push(eip.attrAllocationId);
        });

        // SFTP Server
        const serverProps = {
            domain: 'S3',
            endpointType: 'VPC',
            identityProviderType: 'SERVICE_MANAGED',
            loggingRole: loggingRole.roleArn,
            protocols: ['SFTP'],
            endpointDetails: {
                addressAllocationIds,
                vpcId,
                subnetIds,
                securityGroupIds,
            },
        };
        if (certificateArn) { serverProps.certificate = certificateArn; }
        const server = new CfnServer(this, 'sftpServer', serverProps);
        const serverId = server.attrServerId;
        const domainName = `${serverId}.server.transfer.${this.region}.amazonaws.com`;
        new CfnOutput(this, 'domainName', {
            description: 'Server endpoint hostname',
            value: domainName,
        });

        // DNS Host record
        if (customHostname) {
            const sftpDomainName = `${sftpHostname}.${zoneName}`;
            new CnameRecord(this, 'record', {
                recordName: sftpDomainName,
                domainName,
                zone,
            });
            new CfnOutput(this, 'customHostname', {
                description: 'Custom server hostname',
                value: sftpDomainName,
            });
        }

        // S3 Bucket for incoming files
        const sftpBucket = new Bucket(this, 'sftpBucket', {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            removalPolicy: RemovalPolicy.DESTROY, // this only works if the bucket is empty
        });

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
        users.forEach((user, i) => {
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
        notificationEmails.forEach((email) => {
            notifTopic.addSubscription(new EmailSubscription(email));
        });

        // Lambda Archive =================================================================================================
        // Use a Lambda function to archive files

        // S3 archive bucket
        const archiveBucket = new Bucket(this, 'archiveBucket', {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            removalPolicy: RemovalPolicy.DESTROY, // this only works if the bucket is empty
        });

        // Archive function
        const archiveFnc = new Function(this, 'archiveFnc', {
            description: 'Lambda SFTP Archive Function',
            runtime: Runtime.NODEJS_14_X,
            handler: 'index.handler',
            timeout: Duration.seconds(5),
            code: Code.fromAsset(`${__dirname}/lambda`),
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

module.exports = { AplicationStack };
