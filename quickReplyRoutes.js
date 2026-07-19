const express = require('express');
const router = express.Router();
const { protect } = require('./authMiddleware');
const quickReplyController = require('./quickReplyController');

// Protect all routes
router.use(protect);

router.get('/', quickReplyController.getQuickReplies);
router.post('/', quickReplyController.createQuickReply);
router.put('/:id', quickReplyController.updateQuickReply);
router.delete('/:id', quickReplyController.deleteQuickReply);

module.exports = router;