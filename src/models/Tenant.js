const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  subscriptionStatus: { type: String, enum: ['active', 'inactive', 'trial'], default: 'trial' },
  createdAt: { type: Date, default: Date.now }
});

// Index for quick lookup by email during login
tenantSchema.index({ email: 1 });

module.exports = mongoose.model('Tenant', tenantSchema);
