const axios = require('axios');
const crypto = require('crypto');

const GRAPH_API_BASE_URL = 'https://graph.facebook.com/v19.0';

// টোকেন এনক্রিপ্ট এবং ডিক্রিপ্ট করার জন্য ফাংশন
// প্রোডাকশনে, একটি শক্তিশালী কী ম্যানেজমেন্ট সিস্টেম (KMS) ব্যবহার করার কথা বিবেচনা করুন
const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = crypto.scryptSync(process.env.ENCRYPTION_SECRET, 'salt', 32);
const IV_LENGTH = 16;

const encryptToken = (token) => {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
};

const decryptToken = (encryptedToken) => {
    const [ivHex, encrypted] = encryptedToken.split(':');
    if (!ivHex || !encrypted) {
        throw new Error('Invalid encrypted token format');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
};

/**
 * কোডকে একটি শর্ট-লিভড ইউজার অ্যাক্সেস টোকেনের জন্য এক্সচেঞ্জ করে
 */
const exchangeCodeForAccessToken = async (code) => {
    try {
        const { data } = await axios.get(`${GRAPH_API_BASE_URL}/oauth/access_token`, {
            params: {
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                redirect_uri: `${process.env.SERVER_URL}/auth/facebook/callback`,
                code,
            },
        });
        return data.access_token;
    } catch (error) {
        console.error('Error exchanging code for access token:', error.response?.data);
        throw new Error('Failed to get access token.');
    }
};

/**
 * একটি লং-লিভড ইউজার অ্যাক্সেস টোকেন મેળવે છે
 */
const getLongLivedUserToken = async (shortLivedToken) => {
    try {
        const { data } = await axios.get(`${GRAPH_API_BASE_URL}/oauth/access_token`, {
            params: {
                grant_type: 'fb_exchange_token',
                client_id: process.env.META_APP_ID,
                client_secret: process.env.META_APP_SECRET,
                fb_exchange_token: shortLivedToken,
            },
        });
        return data.access_token;
    } catch (error) {
        console.error('Error getting long-lived user token:', error.response?.data);
        throw new Error('Failed to get long-lived user token.');
    }
};

/**
 * ব্যবহারকারীর প্রোফাইল তথ্য এবং পেজ তালিকা নিয়ে আসে
 */
const getUserProfileAndPages = async (userAccessToken) => {
    try {
        const { data } = await axios.get(`${GRAPH_API_BASE_URL}/me`, {
            params: {
                fields: 'id,name,email,accounts{id,name,access_token,tasks}',
                access_token: userAccessToken,
            },
        });
        // শুধুমাত্র যে পেজগুলোতে ব্যবহারকারীর 'MANAGE' পারমিশন আছে, সেগুলো ফিল্টার করুন
        const manageablePages = data.accounts ? data.accounts.data.filter(page => page.tasks.includes('MANAGE')) : [];
        return { profile: { id: data.id, name: data.name, email: data.email }, pages: manageablePages };
    } catch (error) {
        console.error('Error fetching user profile and pages:', error.response?.data);
        throw new Error('Failed to fetch user profile and pages.');
    }
};

/**
 * একটি পেজকে ওয়েবহুকে সাবস্ক্রাইব করে
 */
const subscribePageToWebhook = async (pageId, pageAccessToken) => {
    try {
        await axios.post(`${GRAPH_API_BASE_URL}/${pageId}/subscribed_apps`, null, {
            params: {
                subscribed_fields: 'messages,messaging_postbacks,messaging_referrals,feed',
                access_token: pageAccessToken,
            },
        });
        console.log(`Successfully subscribed page ${pageId} to webhook.`);
    } catch (error) {
        console.error(`Error subscribing page ${pageId} to webhook:`, error.response?.data?.error?.message || error.message);
        throw new Error('Failed to subscribe page to webhook.');
    }
};

/**
 * একটি পেজকে ওয়েবহুক থেকে আনসাবস্ক্রাইব করে
 */
const unsubscribePageFromWebhook = async (pageId, pageAccessToken) => {
    try {
        await axios.delete(`${GRAPH_API_BASE_URL}/${pageId}/subscribed_apps`, {
            params: {
                access_token: pageAccessToken,
            },
        });
        console.log(`Successfully unsubscribed page ${pageId} from webhook.`);
    } catch (error) {
        console.error(`Error unsubscribing page ${pageId} from webhook:`, error.response?.data.error.message);
        throw new Error('Failed to unsubscribe page from webhook.');
    }
};
/**
 * Sends a text message to a user on behalf of a page.
 * @param {string} psid - The Page-Scoped ID of the user.
 * @param {string} text - The message text to send.
 * @param {string} pageAccessToken - The page access token.
 */
const sendTextMessage = async (psid, text, pageAccessToken) => {
    const requestBody = {
        recipient: {
            id: psid,
        },
        message: {
            text: text,
        },
        messaging_type: 'RESPONSE',
    };

    try {
        const response = await axios.post(`${GRAPH_API_BASE_URL}/me/messages`, requestBody, {
            params: { access_token: pageAccessToken },
        });
        console.log(`Reply sent to PSID: ${psid}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('Error sending message:', error.response?.data?.error || error.message);
        throw new Error(error.response?.data?.error?.message || 'Failed to send message to Facebook');
    }
};

/**
 * Sends a text message with quick replies to a user.
 * @param {string} psid - The Page-Scoped ID of the user.
 * @param {string} text - The message text to send.
 * @param {Array<object>} quickReplies - An array of quick reply objects.
 * @param {string} pageAccessToken - The page access token.
 */
const sendTextMessageWithQuickReplies = async (psid, text, quickReplies, pageAccessToken) => {
    const requestBody = {
        recipient: {
            id: psid,
        },
        message: {
            text: text,
            quick_replies: quickReplies,
        },
        messaging_type: 'RESPONSE',
    };

    try {
        const response = await axios.post(`${GRAPH_API_BASE_URL}/me/messages`, requestBody, {
            params: { access_token: pageAccessToken },
        });
        console.log(`Quick reply sent to PSID: ${psid}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('Error sending quick replies:', error.response?.data?.error || error.message);
        throw new Error(error.response?.data?.error?.message || 'Failed to send quick replies');
    }
};

/**
 * Sends a Generic Template (Carousel) to a user.
 * @param {string} psid - The Page-Scoped ID of the user.
 * @param {Array<object>} elements - An array of elements for the carousel.
 * @param {string} pageAccessToken - The page access token.
 */
const sendGenericTemplate = async (psid, elements, pageAccessToken) => {
    const requestBody = {
        recipient: {
            id: psid,
        },
        message: {
            attachment: {
                type: 'template',
                payload: {
                    template_type: 'generic',
                    elements: elements,
                },
            },
        },
        messaging_type: 'RESPONSE',
    };

    try {
        await axios.post(`${GRAPH_API_BASE_URL}/me/messages`, requestBody, {
            params: { access_token: pageAccessToken },
        });
        console.log(`Generic template sent to PSID: ${psid}`);
    } catch (error) {
        console.error('Error sending generic template:', error.response?.data?.error);
    }
};

const sendImageMessage = async (psid, imageUrl, pageAccessToken) => {
    const requestBody = {
        recipient: { id: psid },
        message: {
            attachment: {
                type: 'image',
                payload: { url: imageUrl, is_reusable: true },
            },
        },
        messaging_type: 'RESPONSE',
    };

    try {
        await axios.post(`${GRAPH_API_BASE_URL}/me/messages`, requestBody, {
            params: { access_token: pageAccessToken },
        });
        console.log(`Image sent to PSID: ${psid}`);
        return true;
    } catch (error) {
        console.error('Error sending image:', error.response?.data?.error || error.message);
        return false;
    }
};

/**
 * Sends a Button Template to a user.
 * @param {string} psid - The Page-Scoped ID of the user.
 * @param {string} text - The text to display above the buttons.
 * @param {Array<object>} buttons - An array of button objects.
 * @param {string} pageAccessToken - The page access token.
 */
const sendButtonTemplate = async (psid, text, buttons, pageAccessToken) => {
    const requestBody = {
        recipient: {
            id: psid,
        },
        message: {
            attachment: {
                type: 'template',
                payload: {
                    template_type: 'button',
                    text: text,
                    buttons: buttons,
                },
            },
        },
        messaging_type: 'RESPONSE',
    };

    try {
        await axios.post(`${GRAPH_API_BASE_URL}/me/messages`, requestBody, {
            params: { access_token: pageAccessToken },
        });
        console.log(`Button template sent to PSID: ${psid}`);
    } catch (error) {
        console.error('Error sending button template:', error.response?.data?.error);
    }
};

/**
 * Sends a sender action to a user (e.g., typing_on, typing_off).
 * @param {string} psid - The Page-Scoped ID of the user.
 * @param {string} senderAction - The sender action to perform ('typing_on', 'typing_off', 'mark_seen').
 * @param {string} pageAccessToken - The page access token.
 */
const sendSenderAction = async (psid, senderAction, pageAccessToken) => {
  try {
    const requestBody = {
      recipient: { id: psid },
      sender_action: senderAction,
    };

    const response = await axios.post(`${GRAPH_API_BASE_URL}/me/messages`, requestBody, {
      params: { access_token: pageAccessToken },
    });
    console.log(`Sender action '${senderAction}' sent to PSID: ${psid}. FB Response:`, response.data);
  } catch (error) {
    console.error(`Error sending sender action '${senderAction}':`, error.response ? error.response.data : error.message);
  }
};

const sendTypingOn = async (psid, pageAccessToken) => {
  await sendSenderAction(psid, 'typing_on', pageAccessToken);
};

const sendTypingOff = async (psid, pageAccessToken) => {
  await sendSenderAction(psid, 'typing_off', pageAccessToken);
};

/**
 * Sets up the Messenger Profile (Persistent Menu, Get Started, Greeting)
 */
const setupMessengerProfile = async (pageAccessToken) => {
    const requestBody = {
        "get_started": {
            "payload": "GET_STARTED_PAYLOAD"
        },
        "greeting": [
            {
            "locale": "default",
            "text": "Welcome to our store! 👋 How can we help you today?"
            }
        ],
        "persistent_menu": [
            {
                "locale": "default",
                "composer_input_disabled": false,
                "call_to_actions": [
                    {
                        "type": "postback",
                        "title": "🛍️ প্রোডাক্ট কালেকশন",
                        "payload": "SHOW_COLLECTION"
                    },
                    {
                        "type": "postback",
                        "title": "🔍 অর্ডার ট্র্যাক করুন",
                        "payload": "TRACK_ORDER"
                    },
                    {
                        "type": "postback",
                        "title": "📞 এজেন্টের সাথে কথা বলুন",
                        "payload": "TALK_TO_AGENT"
                    }
                ]
            }
        ]
    };

    try {
        await axios.post(`${GRAPH_API_BASE_URL}/me/messenger_profile`, requestBody, {
            params: { access_token: pageAccessToken },
        });
        console.log(`Successfully setup Messenger Profile.`);
    } catch (error) {
        console.error('Error setting up Messenger Profile:', error.response?.data?.error);
    }
};

/**
 * Facebook পোস্টের কমেন্টে উত্তর পাঠানোর ফাংশন
 * @param {string} commentId - The ID of the comment to reply to.
 * @param {string} message - The reply message text.
 * @param {string} pageAccessToken - The page access token.
 */
const replyToComment = async (commentId, message, pageAccessToken) => {
    try {
        const response = await axios.post(`${GRAPH_API_BASE_URL}/${commentId}/comments`, {
            message: message,
        }, {
            params: { access_token: pageAccessToken },
        });
        console.log(`Successfully replied to comment ${commentId}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`Error replying to comment ${commentId}:`, error.response?.data?.error || error.message);
        throw new Error(error.response?.data?.error?.message || 'Failed to reply to comment');
    }
};

/**
 * কমেন্ট করা ব্যবহারকারীকে প্রাইভেট ইনবক্স মেসেজ পাঠানোর ফাংশন (Private Reply)
 * @param {string} commentId - The ID of the comment.
 * @param {string} text - The message text.
 * @param {string} pageAccessToken - The page access token.
 */
const sendPrivateReplyToComment = async (commentId, text, pageAccessToken) => {
    const requestBody = {
        recipient: {
            comment_id: commentId,
        },
        message: {
            text: text,
        },
        messaging_type: 'RESPONSE',
    };

    try {
        const response = await axios.post(`${GRAPH_API_BASE_URL}/me/messages`, requestBody, {
            params: { access_token: pageAccessToken },
        });
        console.log(`Private reply sent for comment ID: ${commentId}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('Error sending private reply to comment:', error.response?.data?.error || error.message);
        return { success: false, error: error.response?.data?.error || error.message };
    }
};

module.exports = {
    exchangeCodeForAccessToken,
    getLongLivedUserToken,
    getUserProfileAndPages,
    subscribePageToWebhook,
    unsubscribePageFromWebhook,
    encryptToken,
    decryptToken,
    sendTextMessage,
    sendImageMessage,
    sendGenericTemplate,
    sendButtonTemplate,
    sendSenderAction,
    sendTypingOn,
    sendTypingOff,
    sendTextMessageWithQuickReplies,
    setupMessengerProfile,
    replyToComment,
    sendPrivateReplyToComment,
};
