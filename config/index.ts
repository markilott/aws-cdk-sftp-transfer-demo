export const options = {
    vpcAttr: {
        customVpcId: '', // Use the default VPC if blank
    },
    sftpAttr: {
        moveToArchive: true, // Use a lambda function to move files on upload
        allowCidrs: [], // CIDR notation - if not supplied server will be public
    },
    customHostKey: {
        useCustomKey: false, // Requires secret with base64 encoded Private Key
        hostKeySecretArn: '',
        hostKeyVersion: '0', // Increment/modify to force an update of the host key
    },
    customHostname: {
        useCustomHostname: false, // Requires all of the options below
        certificateArn: '', // Wildcard certificate in the same region
        dnsAttr: {
            zoneName: 'mydomain.com',
            hostedZoneId: '',
        },
        sftpHostname: 'sftp1',
    },
    users: [
        {
            userName: 'testuser',
            publicKey: '',
        },
    ],
    notificationEmails: [], // Send notifications on file uploads
};
