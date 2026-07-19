const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  pageId: { type: String, required: true, unique: true }, // Facebook Page ID
  pageName: { type: String },
  accessToken: { type: String, required: true }, // Long-lived Page Access Token
  isActive: { type: Boolean, default: true },
  settings: {
    humanTakeover: { type: Boolean, default: false }, // Flag for human takeover
    greetingText: { type: String },
  },
  createdAt: { type: Date, default: Date.now }
});

// Index on pageId since we will query this heavily upon receiving webhooks
pageSchema.index({ pageId: 1 });
pageSchema.index({ tenantId: 1 });

module.exports = mongoose.model('Page', pageSchema);
