// d:\allproject\facebookbot\chatbot\test-server.js

const http = require('http');
const url = require('url');

// আপনার ভেরিফাই টোকেনটি এখানে সরাসরি লিখুন
const MY_VERIFY_TOKEN = 'goaladda_secret_token';

const server = http.createServer((req, res) => {
    // শুধুমাত্র /webhook পাথের GET রিকোয়েস্ট হ্যান্ডেল করা হবে
    if (req.method === 'GET' && req.url.startsWith('/webhook')) {
        const parsedUrl = url.parse(req.url, true);
        const query = parsedUrl.query;

        const mode = query['hub.mode'];
        const token = query['hub.verify_token'];
        const challenge = query['hub.challenge'];

        console.log('--- TEST SERVER: Webhook Verification Attempt ---');
        console.log(`[Facebook]   Mode: ${mode}`);
        console.log(`[Facebook]   Token: ${token}`);
        console.log(`[Your App]   Verify Token: ${MY_VERIFY_TOKEN}`);
        console.log(`[Facebook]   Challenge: ${challenge}`);
        console.log('-------------------------------------------------');

        // ফেসবুকের পাঠানো টোকেন এবং আপনার টোকেন মিলিয়ে দেখা হচ্ছে
        if (mode === 'subscribe' && token === MY_VERIFY_TOKEN) {
            console.log('SUCCESS: Webhook verified successfully!');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(challenge);
        } else {
            console.error('ERROR: Webhook verification failed. Tokens do not match or mode is not "subscribe".');
            res.writeHead(403);
            res.end();
        }
    } else {
        // অন্য সব রিকোয়েস্টের জন্য
        res.writeHead(404);
        res.end('Not Found. This server only handles GET /webhook');
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`✅ Test server is running on http://localhost:${PORT}`);
    console.log('Now, in the Meta Developer Portal, use this Callback URL:');
    console.log(`<https://yuriko-choriambic-bell.ngrok-free.app/webhook>`);
    console.log(`And this Verify Token: ${MY_VERIFY_TOKEN}`);
});
