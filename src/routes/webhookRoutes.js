const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const verifySignature = require('../middlewares/verifySignature');

// Webhook Verification (GET)
router.get('/', webhookController.verifyWebhook);

// Webhook Event Receiver (POST)
// We apply the signature verification middleware here
router.post('/', verifySignature, webhookController.handleWebhook);

module.exports = router;
