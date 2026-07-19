const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  pageId: { type: String, required: true }, // Which page this customer interacted with
  psid: { type: String, required: true }, // Page-Scoped ID from Facebook
  firstName: { type: String },
  lastName: { type: String },
  profilePic: { type: String },
  phone: { type: String },
  address: { type: String },
  lastInteractionAt: { type: Date, default: Date.now }
});

// Compound index on pageId and psid because a PSID is unique per Page
customerSchema.index({ pageId: 1, psid: 1 }, { unique: true });

module.exports = mongoose.model('Customer', customerSchema);
