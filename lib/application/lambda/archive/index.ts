import { S3Client, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SNSEvent, S3Event } from 'aws-lambda';

const s3 = new S3Client();

function urlDecode(str: string): string {
    // Removes url encoding from S3 keys in notifications
    return decodeURIComponent(str.replace(/\+/g, ' '));
}

const archiveBucket = process.env.ARCHIVE_BUCKET;

/**
 * Get notification of file upload from S3 and move file to archive
 * @param {object} event - SNS event wrapping the S3 event notification
 */
export const handler = async (event: SNSEvent) => {
    console.log('Event: ', JSON.stringify(event));

    try {
        if (!archiveBucket) { throw new Error('ARCHIVE_BUCKET env variable is required'); }

        const s3Events: S3Event['Records'] = [];
        event.Records.forEach((record) => {
            const msg = JSON.parse(record.Sns.Message) as S3Event;
            msg.Records.forEach((rec) => s3Events.push(rec));
        });
        console.log('s3Events', JSON.stringify((s3Events)));
        await Promise.all(s3Events.map(async (ev) => {
            const { bucket, object } = ev.s3;

            // Copy the file to the archive bucket
            await s3.send(new CopyObjectCommand({
                Bucket: archiveBucket,
                CopySource: `${bucket.name}/${object.key}`, // URL encoding is required here
                Key: urlDecode(object.key), // Original key name wanted
            }));

            // Delete the original file
            await s3.send(new DeleteObjectCommand({
                Bucket: bucket.name,
                Key: urlDecode(object.key), // Original key name required
            }));
        }));
        return { success: true };
    } catch (err) {
        if (!(err instanceof Error)) { throw err; }
        console.log('Error caught: ', err);
        throw err;
    }
};
