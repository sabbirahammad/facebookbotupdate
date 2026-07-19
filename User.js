const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    facebookId: {
        type: String,
        required: true,
        unique: true,
    },
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: false, // Email might not always be available
    },
    accessToken: {
        type: String, // This will be the encrypted token
        required: true,
        select: false, // Don't return accessToken by default
    },
    role: {
        type: String,
        enum: ['user', 'superadmin'],
        default: 'user'
    },
    subscriptionPlan: {
        name: {
            type: String,
            default: 'basic', // নতুন ব্যবহারকারীর জন্য ডিফল্ট প্ল্যান
        },
        pageLimit: {
            type: Number,
            default: 1, // বেসিক প্ল্যানের জন্য ডিফল্ট পেজ লিমিট ১
        },
        aiResponseLimit: {
            type: Number,
            default: 100, // নতুন ব্যবহারকারীর জন্য ডিফল্ট ১০০ রেসপন্স
        },
        aiResponsesUsed: {
            type: Number,
            default: 0,
        },
        startDate: {
            type: Date,
            default: Date.now,
        },
        endDate: {
            type: Date,
            default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // ডিফল্ট ৩০ দিন
        }
    }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);