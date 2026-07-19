const express = require('express');
const User = require('./User');
const Page = require('./Page');
const Order = require('./Order');
const { protect } = require('./authMiddleware');
const dashboardController = require('./dashboardController');

const router = express.Router();

// ব্যবহারকারীর নিজের তথ্য এবং তার পেজ তালিকা আনার জন্য নতুন রুট
router.get('/me', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-accessToken');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        console.log(`[Dashboard API] Fetched user ${user._id} for dashboard. Used AI responses: ${user.subscriptionPlan?.aiResponsesUsed}`);

        const pagesFromDb = await Page.find({ ownerId: user._id }).select('-pageAccessToken').lean();

        res.json({ user, pages: pagesFromDb });
    } catch (error) {
        console.error('Error fetching user and pages:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// আপনার পুরনো ড্যাশবোর্ড সামারি রুট (এটি ঠিকই আছে)
router.get('/summary/:pageId', protect, dashboardController.getDashboardSummary);

// নির্দিষ্ট পেজের অর্ডার আনার রুট
router.get('/orders/:pageId', protect, dashboardController.getOrdersForPage);

// দৈনিক আয়ের রুট
router.get('/daily-revenue/:pageId', protect, dashboardController.getDailyRevenue);

// নির্দিষ্ট পেজের গ্রাহকদের আনার রুট
router.get('/customers/:pageId', protect, dashboardController.getCustomersForPage);

module.exports = router;