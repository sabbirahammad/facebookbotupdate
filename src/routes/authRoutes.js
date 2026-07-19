const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Route to start the Facebook OAuth flow
// In a real application, you would protect this route and get the tenantId from the session/token.
// For simplicity in this structure, we accept tenantId as a query parameter.
router.get('/facebook', authController.facebookLogin);

// Route for Facebook OAuth callback
router.get('/facebook/callback', authController.facebookCallback);

module.exports = router;
