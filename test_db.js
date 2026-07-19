const mongoose = require('mongoose');
const User = require('./User');
require('dotenv').config();

async function test() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/facebookbot');
    const users = await User.find({});
    users.forEach(u => {
        console.log(`User ID: ${u._id} | Limit: ${u.subscriptionPlan?.aiResponseLimit} | Used: ${u.subscriptionPlan?.aiResponsesUsed}`);
    });
    process.exit(0);
}
test();
