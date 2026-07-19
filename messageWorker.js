const { Worker } = require('bullmq');
const { processMessage } = require('./messageProcessor');

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
};

const processWebhookEvent = async (job) => {
    console.log(`Processing job ${job.id} with data:`, job.data);
    try {
        const processed = await processMessage(job.data);
        if (processed) {
            console.log(`Successfully processed job ${job.id}`);
        } else {
            throw new Error(`No reply was generated for job ${job.id}`);
        }
    } catch (error) {
        console.error(`Failed to process job ${job.id}:`, error);
        // জবটি ব্যর্থ হয়েছে, তাই BullMQ এটিকে পুনরায় চেষ্টা করবে।
        throw error;
    }
};

const worker = new Worker('messenger-events', processWebhookEvent, { connection });

worker.on('failed', (job, err) => {
    // This event is triggered when a job fails after all retry attempts.
    console.error(`Job ${job.id} has failed with error: ${err.message}`);
});

worker.on('error', err => {
    // This can catch generic worker errors, including Redis connection issues during operation.
    console.error('An error occurred in the message worker:', err);
});

console.log("Message worker started and listening for jobs...");