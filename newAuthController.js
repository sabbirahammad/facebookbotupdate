const User = require('./User');
const Page = require('./Page');
const jwt = require('jsonwebtoken');
const facebookService = require('./facebookService');

// Redirects user to Facebook login dialog
exports.initiateFacebookAuthV2 = (req, res) => {
    console.log('--- Using newAuthController: initiateFacebookAuthV2 ---');
    const correctScopes = 'public_profile,email,pages_read_engagement,pages_messaging,pages_manage_metadata';
    const redirectURI = `${process.env.BASE_URL || process.env.SERVER_URL}/auth/facebook/callback`;
    const clientId = process.env.FB_APP_ID || process.env.META_APP_ID;
    const authURL = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${clientId}&redirect_uri=${redirectURI}&scope=${correctScopes}&response_type=code`;

    res.redirect(authURL);
};