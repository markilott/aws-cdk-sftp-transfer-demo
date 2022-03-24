// eslint-disable-next-line import/no-extraneous-dependencies
const AWS = require('aws-sdk');

const s3 = new AWS.S3();

function urlDecode(str) {
    // Removes url encoding from S3 keys in notifications
    return decodeURIComponent(str.replace(/\+/g, ' '));
}

const archiveBucket = process.env.ARCHIVE_BUCKET;

/**
 * Get notification of file upload from S3 and move file to archive
 * @param {object} event
 * @param {object[]} event.Records - SNS Records
 * @param {string} event.Records[].Sns.Message - S3 event notification
 * @param {object[]} event.Records[].Sns.Message.Records - S3 events
 */
exports.handler = async (event) => {
    console.log('Event: ', JSON.stringify(event));

    try {
        const s3Events = [];
        event.Records.forEach((record) => {
            const msg = JSON.parse(record.Sns.Message);
            msg.Records.forEach((rec) => s3Events.push(rec));
        });
        console.log('s3Events', JSON.stringify((s3Events)));
        await Promise.all(s3Events.map(async (ev) => {
            const { bucket, object } = ev.s3;

            // Copy the file to the archive bucket
            await s3.copyObject({
                Bucket: archiveBucket,
                CopySource: `${bucket.name}/${object.key}`, // URL encoding is required here
                Key: urlDecode(object.key), // Original key name wanted
            }).promise();

            // Delete the original file
            await s3.deleteObject({
                Bucket: bucket.name,
                Key: urlDecode(object.key), // Original key name required
            }).promise();
        }));
        return { success: true };
    } catch (err) {
        err.message = (err.message) || 'Internal handler error';
        console.log('Error caught: ', err);
        throw err;
    }
};
