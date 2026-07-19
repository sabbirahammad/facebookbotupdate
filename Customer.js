const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
    pageId: {
        type: String,
        required: true,
    },
    psid: {
        type: String,
        required: true,
    },
    name: {
        type: String,
        required: true,
    },
    phone: {
        type: String,
    },
    address: {
        type: String,
    },
    tags: {
        type: [String],
        default: [],
    },
}, { timestamps: true });

// Ensure a customer is unique per page
customerSchema.index({ pageId: 1, psid: 1 }, { unique: true });

module.exports = mongoose.model('Customer', customerSchema);