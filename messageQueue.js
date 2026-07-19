const { Queue } = require('bullmq');
const { processMessage } = require('./messageProcessor');

const useRedis = process.env.USE_REDIS === 'true';
let messageQueue;

if (useRedis) {
  // Use REDIS_URL if available, otherwise fall back to host/port.
  const connection = process.env.REDIS_URL || { host: process.env.REDIS_HOST || '127.0.0.1', port: process.env.REDIS_PORT || 6379 };

  // 'messenger-events' নামে একটি নতুন কিউ তৈরি করা হচ্ছে
  messageQueue = new Queue('messenger-events', { connection });

  messageQueue.on('error', (error) => {
    // Log any errors that the queue encounters
    console.error('A message queue error occurred:', error);
  });

  console.log("Redis Message queue initialized.");
} else {
  // In-memory fallback
  messageQueue = {
    add: async (name, data) => {
      setTimeout(async () => {
        try {
          await processMessage(data);
        } catch (err) {
          console.error("Local queue processing error:", err);
        }
      }, 0);
    }
  };
}

module.exports = messageQueue;