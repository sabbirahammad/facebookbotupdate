const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name: { type: String, required: true },
  description: { type: String },
  price: { type: Number, required: true },
  currency: { type: String, default: 'BDT' },
  stock: { type: Number, default: 0 },
  images: [{ type: String }],
  isActive: { type: Boolean, default: true }
});

// Useful for quickly fetching all products for a specific tenant
productSchema.index({ tenantId: 1 });

module.exports = mongoose.model('Product', productSchema);
