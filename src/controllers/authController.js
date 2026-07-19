const axios = require('axios');
const Page = require('../models/Page');

const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const REDIRECT_URI = process.env.BASE_URL + '/auth/facebook/callback';
const GRAPH_API_VERSION = 'v19.0';

// 1. Redirect User to Facebook for Login
exports.facebookLogin = (req, res) => {
  // Pass the tenantId in the state parameter to know who is connecting the page
  const tenantId = req.query.tenantId; 
  if (!tenantId) {
    return res.status(400).send('tenantId is required');
  }

  // Requesting permissions for pages list, sending messages, and reading page settings
  const scopes = ['public_profile', 'email', 'pages_read_engagement', 'pages_messaging', 'pages_manage_metadata'].join(',');
  const authUrl = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${REDIRECT_URI}&scope=${scopes}&state=${tenantId}`;
  
  res.redirect(authUrl);
};

// 2. Handle Callback, Exchange Tokens, and Subscribe Webhook
exports.facebookCallback = async (req, res) => {
  const code = req.query.code;
  const tenantId = req.query.state; // We passed tenantId in the state parameter

  if (!code) {
    return res.status(400).send('Authorization failed: No code received');
  }

  try {
    // Step A: Exchange code for a short-lived User Access Token
    const tokenResponse = await axios.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`, {
      params: {
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code: code
      }
    });
    
    const shortLivedUserToken = tokenResponse.data.access_token;

    // Step B: Exchange short-lived token for a long-lived User Access Token (Valid for 60 days)
    const longLivedTokenResponse = await axios.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortLivedUserToken
      }
    });

    const longLivedUserToken = longLivedTokenResponse.data.access_token;

    // Step C: Get all Pages managed by the User
    const pagesResponse = await axios.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts`, {
      params: {
        access_token: longLivedUserToken
      }
    });

    const pages = pagesResponse.data.data;
    const connectedPages = [];

    // Step D: Iterate over each page, save to DB, and subscribe to Webhook
    for (const page of pages) {
      const pageId = page.id;
      const pageName = page.name;
      // Because we used a long-lived User Token, the Page Token generated here is also a long-lived Page Access Token (does not expire by default)
      const pageAccessToken = page.access_token; 

      // 1. Save or update the Page in the Database
      const updatedPage = await Page.findOneAndUpdate(
        { pageId: pageId },
        { 
          tenantId: tenantId, 
          pageName: pageName, 
          accessToken: pageAccessToken,
          isActive: true
        },
        { upsert: true, new: true }
      );
      
      connectedPages.push({ id: pageId, name: pageName });

      // 2. Subscribe the Page to your App's Webhook
      try {
        await axios.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/subscribed_apps`, null, {
          params: {
            access_token: pageAccessToken,
            subscribed_fields: 'messages,messaging_postbacks,messaging_optins'
          }
        });
        console.log(`Successfully subscribed webhook for page: ${pageName}`);
      } catch (webhookError) {
        console.error(`Failed to subscribe webhook for page ${pageName}:`, webhookError.response ? webhookError.response.data : webhookError.message);
      }
    }

    res.status(200).json({
      message: 'Facebook Pages connected and webhooks subscribed successfully!',
      pages: connectedPages
    });

  } catch (error) {
    console.error('OAuth Error:', error.response ? error.response.data : error.message);
    res.status(500).send('Internal Server Error during Facebook OAuth');
  }
};
