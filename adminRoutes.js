const express = require('express');
const router = express.Router();
const User = require('./User');
const { protect } = require('./authMiddleware');
const { isAdmin } = require('./adminMiddleware');

// এই ফাইলের সমস্ত রুটের জন্য protect এবং isAdmin middleware ব্যবহার করা হবে
router.use(protect, isAdmin);

/**
 * GET /api/admin/users
 * সকল ব্যবহারকারীর তালিকা নিয়ে আসে
 */
router.get('/users', async (req, res) => {
    try {
        // Fetch all users including superadmins so the admin can test with their own account
        const users = await User.find({}).select('name email role subscriptionPlan createdAt');
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching users.' });
    }
});

/**
 * PATCH /api/admin/users/:userId/plan
 * একজন ব্যবহারকারীর সাবস্ক্রিপশন প্ল্যান আপডেট করে
 */
router.patch('/users/:userId/plan', async (req, res) => {
    try {
        const { userId } = req.params;
        const { planName, pageLimit, aiResponseLimit, startDate, endDate } = req.body;

        const updatedUser = await User.findByIdAndUpdate(userId, {
            $set: {
                'subscriptionPlan.name': planName,
                'subscriptionPlan.pageLimit': pageLimit,
                'subscriptionPlan.aiResponseLimit': aiResponseLimit,
                'subscriptionPlan.startDate': startDate,
                'subscriptionPlan.endDate': endDate,
            }
        }, { new: true });

        res.json({ message: 'User plan updated successfully.', user: updatedUser });
    } catch (error) {
        res.status(500).json({ message: 'Server error while updating user plan.' });
    }
});

module.exports = router;