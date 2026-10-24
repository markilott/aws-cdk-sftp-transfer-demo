import { TransferClient, UpdateServerCommand } from '@aws-sdk/client-transfer';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudFormationCustomResourceEvent } from 'aws-lambda';

const transfer = new TransferClient();
const sm = new SecretsManagerClient();

type ResourceProperties = {
    ServiceToken: string,
    serverId?: string,
    hostKeySecretArn?: string,
    hostKeyVersion?: string,
};

/**
 * Custom CloudFormation resource (Provider onEvent handler) to update the
 * SFTP Server Host Key.
 */
export const handler = async (event: CloudFormationCustomResourceEvent<ResourceProperties>) => {
    console.log('Event: ', JSON.stringify(event));
    try {
        const { RequestType, RequestId, ResourceProperties: props } = event;
        const { serverId = '', hostKeySecretArn = '', hostKeyVersion = '' } = props;
        const physicalResourceId = ('PhysicalResourceId' in event) ? event.PhysicalResourceId : undefined;

        // We do not need to do anything for a delete event
        if (RequestType === 'Delete') {
            console.log('Delete request received - ignoring it');
            return {
                PhysicalResourceId: physicalResourceId,
            };
        }

        // Create and Update events require the same action
        if (!serverId) { throw new Error('Missing serverId'); }
        if (!hostKeySecretArn) { throw new Error('Missing hostKeySecretArn'); }

        // Get the key from SecretsManager and convert from base64 to text
        console.log('Getting and converting the key...');
        const { SecretString } = await sm.send(new GetSecretValueCommand({
            SecretId: hostKeySecretArn,
        }));
        const b64 = Buffer.from(SecretString || '', 'base64');
        const key = b64.toString('ascii');

        // Update the host key on the server
        console.log('Updating the server...');
        const { ServerId } = await transfer.send(new UpdateServerCommand({
            ServerId: serverId,
            HostKey: key,
        }));
        console.log(`Updated host key for server: ${ServerId} to version: ${hostKeyVersion}`);

        // Return a new Id for Create or the existing Id for Update
        return {
            PhysicalResourceId: (RequestType === 'Create') ? RequestId : physicalResourceId,
        };
    } catch (err) {
        if (!(err instanceof Error)) { throw err; }
        console.log('Error caught: ', err);
        throw err;
    }
};
