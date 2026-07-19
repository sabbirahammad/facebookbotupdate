const mongoose = require('mongoose');
const User = require('./User');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/chatbot')
    .then(async () => {
        // Find the user's real account (Sabbir) or any existing account and make it superadmin
        const realUser = await User.findOne({ name: /sabbir/i }) || await User.findOne();
        if (realUser) {
            realUser.role = 'superadmin';
            await realUser.save();
            console.log(`✅ Updated account "${realUser.name}" to superadmin.`);
        } else {
            console.log('No real user found to make superadmin.');
        }

        // Create dummy users so the admin panel has data to display
        const dummy1 = await User.findOne({ facebookId: 'dummy1' });
        if (!dummy1) {
            await User.create({
                facebookId: 'dummy1',
                name: 'Rahim Uddin',
                email: 'rahim@example.com',
                accessToken: 'fake_token_1',
                role: 'user',
                subscriptionPlan: { name: 'basic', pageLimit: 1 }
            });
            console.log('✅ Created dummy user: Rahim Uddin');
        }

        const dummy2 = await User.findOne({ facebookId: 'dummy2' });
        if (!dummy2) {
            await User.create({
                facebookId: 'dummy2',
                name: 'Karim Hasan',
                email: 'karim@example.com',
                accessToken: 'fake_token_2',
                role: 'user',
                subscriptionPlan: { name: 'pro', pageLimit: 5 }
            });
            console.log('✅ Created dummy user: Karim Hasan');
        }

        process.exit(0);
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
