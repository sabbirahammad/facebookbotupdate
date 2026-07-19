const mongoose = require('mongoose');
const User = require('./User');
require('dotenv').config();

async function test() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://sabbir123:sabbir321@cluster0.sxmvwzf.mongodb.net/shopDB');
    await User.updateMany({}, { $set: { 'subscriptionPlan.aiResponsesUsed': 5 } });
    console.log("Updated all users to 5 used responses");
    process.exit(0);
}
test();
