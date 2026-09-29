const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema({
    ownerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    pageId: {
        type: String,
        required: true,
        unique: true,
    },
    name: {
        type: String,
        required: true,
    },
    pageAccessToken: {
        type: String, // Encrypted token
        required: true,
        select: false,
    },
    aiSystemPrompt: { // কাস্টম প্রম্পট
        type: String,
        default: '', 
    },
    useDefaultPrompt: { // সুপার অ্যাডমিনের ডিফল্ট প্রম্পট ব্যবহার করবে কি না
        type: Boolean,
        default: true
    },
    businessType: { // তুমি কি বিজনেস করবা?
        type: String,
        default: ''
    },
    isSubscribed: {
        type: Boolean,
        default: false,
    },
    humanTakeover: {
        type: Boolean,
        default: false,
    },
    autoCommentReply: {
        type: Boolean,
        default: true,
    },
    privateReplyEnabled: {
        type: Boolean,
        default: false,
    },
    commentReplyMode: {
        type: String,
        enum: ['ai', 'custom'],
        default: 'ai',
    },
    customCommentReply: {
        type: String,
        default: '',
    },
}, { timestamps: true });

module.exports = mongoose.model('Page', pageSchema);