const axios = require('axios');

async function testWebhook() {
    const pageId = '1080690761800329';
    const psid = '26010996855265627';
    
    const payload = {
        object: 'page',
        entry: [{
            id: pageId,
            time: Date.now(),
            messaging: [{
                sender: { id: psid },
                recipient: { id: pageId },
                timestamp: Date.now(),
                message: { text: 'test ai response 123' }
            }]
        }]
    };

    try {
        console.log("Sending webhook event...");
        const res = await axios.post('http://localhost:3000/webhook', payload);
        console.log("Webhook response:", res.status);
    } catch (e) {
        console.error("Error:", e.message);
    }
}

testWebhook();
