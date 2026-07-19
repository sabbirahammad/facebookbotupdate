const mongoose = require('mongoose');

const chatLogSchema = new mongoose.Schema({
  pageId: { type: String, required: true },
  psid: { type: String, required: true },
  sender: { type: String, enum: ['user', 'bot', 'human'], required: true },
  messageType: { type: String, enum: ['text', 'postback', 'image', 'quick_reply'], default: 'text' },
  content: { type: String },
  payload: { type: String }, // For postbacks or quick_replies
  timestamp: { type: Date, default: Date.now }
});

// Index to quickly fetch chat history between a page and a specific user, sorted by time
chatLogSchema.index({ pageId: 1, psid: 1, timestamp: 1 });

module.exports = mongoose.model('ChatLog', chatLogSchema);
