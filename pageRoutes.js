const express = require('express');
const router = express.Router();
const pageController = require('./pageController');
const { protect } = require('./authMiddleware');

// একটি নির্দিষ্ট পেজকে ওয়েবহুকে সাবস্ক্রাইব করার জন্য নতুন রুট
router.post('/:pageId/subscribe', pageController.subscribePage);

// একটি নির্দিষ্ট পেজকে ওয়েবহুক থেকে আনসাবস্ক্রাইব করার জন্য রুট
router.delete('/:pageId/unsubscribe', pageController.unsubscribePage);

// একটি নির্দিষ্ট পেজের কনফিগারেশন আপডেট করার জন্য রাউট
router.patch('/:pageId/config', pageController.updatePageConfig);

// একটি নির্দিষ্ট পেজের জন্য 'Human Takeover' মোড টগল করার জন্য রাউট
router.patch('/:pageId/human-takeover', pageController.toggleHumanTakeover);

// ডিবাগিং এর জন্য: একটি পেজের টোকেন সার্ভার টার্মিনালে লগ করার জন্য রুট
router.post('/:pageId/debug-token', pageController.debugToken);

// Generate AI business rules for a page
router.post('/:pageId/generate-business-rules', pageController.generateBusinessRules);

module.exports = router;