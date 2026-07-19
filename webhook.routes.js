const express = require('express');
const router = express.Router();
const webhookController = require('./webhookController');

// এই রাউটটি GET (verification) এবং POST (events) উভয় অনুরোধই পরিচালনা করবে
router.route('/')
    .get(webhookController.processWebhook)
    .post(webhookController.processWebhook);

module.exports = router;