const Redis = require('ioredis');

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || 6379;

// Use REDIS_URL if available (for cloud services like Upstash), otherwise fall back to host/port.
const redisConnection = process.env.REDIS_URL || { host: redisHost, port: redisPort };
const redisClient = new Redis(redisConnection);

redisClient.on('connect', () => {
  console.log('✅ Connected to Redis successfully.');
});

redisClient.on('error', (err) => {
  // If the connection is refused, it likely means Redis isn't running.
  // Log a helpful message and exit to prevent the app from running in a broken state.
  if (err.code === 'ECONNREFUSED') {
    console.error(`❌ Connection to Redis failed at ${redisHost}:${redisPort}. The connection was refused.`);
    console.error('Please ensure that your Redis server (e.g., via Docker) is running and accessible.');
    console.error('The application will now exit.');
    process.exit(1); // Exit the application if Redis is not available on startup
  }
});

const SESSION_EXPIRY_SECONDS = 3600; // সেশন ৬০ মিনিটের জন্য স্থায়ী হবে

/**
 * Redis থেকে ব্যবহারকারীর সেশন ডেটা নিয়ে আসে।
 * @param {string} psid - ব্যবহারকারীর Page-Scoped ID.
 * @returns {Promise<object|null>} সেশন অবজেক্ট অথবা null.
 */
const getSession = async (psid) => {
    const sessionKey = `session:${psid}`;
    const sessionData = await redisClient.get(sessionKey);
    return sessionData ? JSON.parse(sessionData) : null;
};

/**
 * Redis-এ ব্যবহারকারীর সেশন ডেটা সংরক্ষণ করে।
 * @param {string} psid - ব্যবহারকারীর Page-Scoped ID.
 * @param {object} sessionData - সেশন ডেটা যা সংরক্ষণ করতে হবে।
 */
const setSession = async (psid, sessionData) => {
    const sessionKey = `session:${psid}`;
    // JSON স্ট্রিং হিসেবে ডেটা সংরক্ষণ করুন এবং একটি এক্সপায়ারি সময় সেট করুন
    await redisClient.set(sessionKey, JSON.stringify(sessionData), 'EX', SESSION_EXPIRY_SECONDS);
};

/**
 * Redis থেকে ব্যবহারকারীর সেশন মুছে ফেলে।
 * @param {string} psid - ব্যবহারকারীর Page-Scoped ID.
 */
const deleteSession = async (psid) => {
    const sessionKey = `session:${psid}`;
    await redisClient.del(sessionKey);
};

module.exports = { getSession, setSession, deleteSession };