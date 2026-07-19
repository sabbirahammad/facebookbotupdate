const mongoose = require('mongoose');

const chatLogSchema = new mongoose.Schema({
    pageId: { type: String, required: true, index: true },
    psid: { type: String, required: true, index: true },
    sender: {
        type: String,
        enum: ['user', 'bot'],
        required: true,
    },
    message: {
        type: Object,
        required: true,
    },
    timestamp: {
        type: Date,
        default: Date.now,
    },
});

module.exports = mongoose.model('ChatLog', chatLogSchema);