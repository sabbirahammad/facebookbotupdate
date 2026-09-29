require('dotenv').config();
const express = require('express');
const path = require('path'); // path মডিউলটি ইম্পোর্ট করুন
const mongoose = require('mongoose');
const cors = require('cors');
const webhookRoutes = require('./webhook.routes');
const authRoutes = require('./auth.routes');
const pageRoutes = require('./pageRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const productRoutes = require('./productRoutes');
const productController = require('./productController');
const orderRoutes = require('./orderRoutes'); // This seems to be a duplicate import
const inboxRoutes = require('./inboxRoutes'); // আপনার তৈরি করা নতুন রুট ফাইলটিযোগ করা হয়েছে
const quickReplyRoutes = require('./quickReplyRoutes');
const adminRoutes = require('./adminRoutes');
const settingsRoutes = require('./settingsRoutes');
const { setupWebSocket } = require('./websocket');
const { protect } = require('./authMiddleware'); // This should be './authMiddleware'
const useRedis = process.env.USE_REDIS === 'true';

if (useRedis) {
  const IORedis = require('ioredis');
  const redisConnection = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null
  });

  redisConnection.on('error', err => {
      console.error('❌ Could not connect to Redis. Please ensure Redis is running.');
      console.error('Application is shutting down due to Redis connection failure.');
      process.exit(1);
  });

  // ওয়ার্কারকে ইম্পোর্ট করুন যাতে এটি কাজ শুরু করতে পারে
  require('./messageWorker');
} else {
  console.log('Redis is disabled (USE_REDIS!=true). Using local in-memory message processing.');
}

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// Enable CORS for all routes
app.use(cors());

// Webhook রুটের জন্য raw body প্রয়োজন, তাই এর জন্য আলাদাভাবে body-parser ব্যবহার করা হবে
app.use('/webhook', express.raw({ type: 'application/json' }));

// অন্যান্য সব রুটের জন্য express.json() ব্যবহার করা হবে
app.get('/uploads/products/:productId', productController.getProductImage);
app.get('/uploads/products/:productId/:imageIndex', productController.getProductImage);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json());

// Routes
app.use('/webhook', webhookRoutes);
app.use('/auth', authRoutes);
app.get('/', (req, res) => {
    res.send('AI Chatbot SaaS Platform is running! <a href="/auth/facebook/login">Login with Facebook</a>');
});

// --- API Routes ---
// একটি প্রধান API রাউটার তৈরি করুন
const apiRouter = express.Router();
// এই প্রধান রাউটারের জন্য protect মিডলওয়্যার ব্যবহার করুন
apiRouter.use(protect);

// সমস্ত API রুটকে apiRouter-এর অধীনে আনুন
apiRouter.use('/pages', pageRoutes);
apiRouter.use('/dashboard', dashboardRoutes);
apiRouter.use('/products', productRoutes);
apiRouter.use('/orders', orderRoutes);
apiRouter.use('/inbox', inboxRoutes); // ইনবক্স রুটকে API রাউটারের সাথে যুক্ত করা হয়েছে
apiRouter.use('/quick-replies', quickReplyRoutes);

// প্রধান অ্যাপে /api প্রিফিক্স সহ apiRouter যোগ করুন
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api', apiRouter);

// Database connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/chatbot', {
  // Mongoose 6+ no longer requires these options
}).then(() => {
  console.log('Connected to MongoDB');  
  const server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });

  // WebSocket সার্ভার সেটআপ করুন
  setupWebSocket(server);

  // Graceful shutdown
  process.on('SIGINT', () => {
    server.close(() => console.log('Server closed.'));
  });
}).catch(err => {
  console.error('Database connection error:', err);
});
