const { Queue } = require('bullmq');

// Use REDIS_URL if available, otherwise fall back to host/port.
const connection = process.env.REDIS_URL || { host: process.env.REDIS_HOST || '127.0.0.1', port: process.env.REDIS_PORT || 6379 };

// 'messenger-events' নামে একটি নতুন কিউ তৈরি করা হচ্ছে
const messageQueue = new Queue('messenger-events', { connection });

messageQueue.on('error', (error) => {
  // Log any errors that the queue encounters
  console.error('A message queue error occurred:', error);
});

console.log("Message queue initialized.");

module.exports = messageQueue;