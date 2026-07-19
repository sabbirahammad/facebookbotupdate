const express = require('express');
const router = express.Router();
const authController = require('./authController');

// ফেসবুক অথেন্টিকেশন শুরু করার জন্য রাউট
router.get('/facebook/login', authController.initiateFacebookAuth);

// ফেসবুক থেকে কলব্যাক হ্যান্ডেল করার জন্য রাউট
router.get('/facebook/callback', authController.handleFacebookCallback);

module.exports = router;