// eslint-disable-next-line import/no-extraneous-dependencies
const AWS = require('aws-sdk');

const transfer = new AWS.Transfer();
const sm = new AWS.SecretsManager();

exports.handler = async (event) => {
    /**
     * Custom CloudFormation resource to update SFTP Server Host Key
     * @param {string} RequestType - Cfn event type: Create, Update, Delete
     * @param {string} LogicalResourceId - CloudFormation resource Id
     * @param {string} PhysicalResourceId - AWS resource Id
     * @param {object} ResourceProperties - properties passed from the template
     * @param {object} OldResourceProperties - previous properties passed from the template (for Update events)
     * @param {string} ResourceType - The resource type defined for this custom resource in the template
     * @param {string} RequestId
     * @param {string} StackId
     */
    console.log('Event: ', JSON.stringify(event));
    try {
        const {
            RequestType, PhysicalResourceId, ResourceProperties, RequestId,
        } = event;
        const { serverId = '', hostKeySecretArn = '', hostKeyVersion = '' } = ResourceProperties;
        const validTypes = ['Create', 'Update', 'Delete'];
        if (!validTypes.includes(RequestType)) { throw new Error('Invalid RequestType'); }

        // We do not need to do anything for a delete event
        if (RequestType === 'Delete') {
            console.log('Delete request received - ignoring it');
            return {
                PhysicalResourceId,
            };
        }

        // Create and Update events require the same action
        if (!serverId) { throw new Error('Missing serverId'); }
        if (!hostKeySecretArn) { throw new Error('Missing hostKeySecretArn'); }

        // Get the key from SecretsManager and convert from base64 to text
        console.log('Getting and converting the key...');
        const b64 = Buffer.from((await sm.getSecretValue({
            SecretId: hostKeySecretArn,
        }).promise()).SecretString, 'base64');
        const key = b64.toString('ascii');

        // Update the host key on the server
        console.log('Updating the server...');
        const { ServerId } = await transfer.updateServer({
            ServerId: serverId,
            HostKey: key,
        }).promise();
        console.log(`Updated host key for server: ${ServerId} to version: ${hostKeyVersion}`);

        // Return a new Id for Create or the existing Id for Update
        return {
            PhysicalResourceId: (RequestType === 'Create') ? RequestId : PhysicalResourceId,
        };
    } catch (err) {
        err.message = (err.message) || 'Handler error';
        console.log('Error caught: ', err);
        throw err;
    }
};
