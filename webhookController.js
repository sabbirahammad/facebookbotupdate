const crypto = require('crypto');
const messageQueue = require('./messageQueue');
const { broadcastToPage } = require('./websocket');

/**
 * Facebook থেকে আসা GET (verification) এবং POST (event) উভয় ধরনের Webhook অনুরোধ পরিচালনা করে।
 */
exports.processWebhook = (req, res) => {
    console.log(`\n[🔔 WEBHOOK HIT] Method: ${req.method} | Path: ${req.originalUrl}`);
    if (req.method === 'GET') {
        // --- Webhook Verification Logic ---
        const verifyToken = process.env.VERIFY_TOKEN;
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        console.log('--- Webhook Verification Attempt ---');
        console.log(`[Facebook] Mode: ${mode}`);
        console.log(`[Facebook] Token: ${token}`);
        console.log(`[Your App] Verify Token: ${verifyToken}`);

        if (mode === 'subscribe' && token === verifyToken) {
            console.log('Webhook verified successfully!');
            res.status(200).send(challenge);
        } else {
            console.error('Webhook verification failed.');
            if (token !== verifyToken) {
                console.error(`Tokens do not match. Received: "${token}", Expected: "${verifyToken}"`);
            }
            res.sendStatus(403);
        }

    } else if (req.method === 'POST') {
        // --- Webhook Event Handling Logic ---
        console.log('--- Received Webhook POST Event ---');

        const signature = req.headers['x-hub-signature-256'];
        if (!signature) {
            console.error('Signature not found in request headers. Rejecting request.');
            return res.status(400).send('Signature not found.');
        }

        if (!process.env.META_APP_SECRET) {
            console.error('META_APP_SECRET is not set. Cannot verify signature.');
            return res.status(500).send('Server configuration error.');
        }

        // server.js-এ express.raw() ব্যবহার করার কারণে req.body এখন একটি buffer
        const expectedSignature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.body).digest('hex');

        if (signature !== expectedSignature) {
            console.error('Invalid signature. Rejecting request.');
            console.log('Received Signature:', signature);
            console.log('Expected Signature:', expectedSignature);
            return res.status(403).send('Invalid signature.');
        }

        console.log('Signature verified successfully. Processing event...');
        
        // যেহেতু req.body এখন raw buffer, এটিকে JSON হিসেবে পার্স করতে হবে
        const bodyParsed = JSON.parse(req.body.toString());

        // নিশ্চিত করুন যে এটি একটি পেজ ইভেন্ট
        if (bodyParsed.object !== 'page') {
            console.log('Received event is not from a page. Skipping.');
            return res.sendStatus(200);
        }

        bodyParsed.entry.forEach(entry => {
            const pageId = entry.id;
            
            if (entry.messaging) {
                entry.messaging.forEach(messagingEvent => {
                    if (messagingEvent.sender && messagingEvent.sender.id) {
                        if (messagingEvent.sender_action) {
                            // Handle typing indicators
                            const psid = messagingEvent.sender.id;
                            if (messagingEvent.sender_action === 'typing_on') {
                                broadcastToPage(pageId, { type: 'typing_on', psid });
                            } else if (messagingEvent.sender_action === 'typing_off') {
                                broadcastToPage(pageId, { type: 'typing_off', psid });
                            }
                            return;
                        }
                        const jobData = {
                            pageId: pageId,
                            psid: messagingEvent.sender.id,
                            message: messagingEvent.message,
                            postback: messagingEvent.postback,
                            type: messagingEvent.message ? 'message' : 'postback',
                        };

                        console.log(`[Webhook] Adding job to queue for page ${pageId} and user ${jobData.psid}`);
                        messageQueue.add('messenger-events', jobData);
                    }
                });
            }

            // Handle feed changes (Comments on Page Posts)
            if (entry.changes) {
                entry.changes.forEach(change => {
                    console.log(`[Webhook Change] Field: ${change.field}`);
                    if (change.field === 'feed') {
                        const val = change.value || {};
                        console.log(`[Webhook Feed Details] Item: ${val.item}, Verb: ${val.verb}, CommentID: ${val.comment_id || val.id}`);
                        
                        if (val.item === 'comment' && (!val.verb || val.verb === 'add')) {
                            const commentId = val.comment_id || val.id;
                            const senderId = val.sender_id || val.from?.id;
                            const senderName = val.sender_name || val.from?.name || 'User';
                            const commentText = val.message || val.text || '';
                            const postId = val.post_id;
                            const parentId = val.parent_id;

                            console.log(`[Webhook Comment Detected] Page: ${pageId}, Sender: ${senderName} (${senderId}), Text: "${commentText}"`);

                            // Avoid self-reply loop if the comment was published by the page itself
                            if (senderId && senderId !== pageId && commentText) {
                                const jobData = {
                                    type: 'comment',
                                    pageId: pageId,
                                    commentId: commentId,
                                    senderId: senderId,
                                    senderName: senderName,
                                    commentText: commentText,
                                    postId: postId,
                                    parentId: parentId,
                                };
                                console.log(`[Webhook] Queueing comment reply job for page ${pageId}, comment ${commentId}`);
                                messageQueue.add('messenger-events', jobData);
                            } else if (senderId === pageId) {
                                console.log(`[Webhook Comment] Ignored page's own comment to prevent self-reply loop.`);
                            }
                        }
                    }
                });
            }
        });

        res.sendStatus(200);
    }
};