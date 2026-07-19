const mongoose = require('mongoose');

const quickReplySchema = new mongoose.Schema({
  title: { type: String, required: true },
  text: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, {
  timestamps: true,
});

const QuickReply = mongoose.model('QuickReply', quickReplySchema);

module.exports = QuickReply;