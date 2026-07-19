// Verify Webhook for Facebook
exports.verifyWebhook = (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
};

// Handle Incoming Webhook Events
exports.handleWebhook = async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    // Return a '200 OK' response to all requests, within 20 seconds, ideally within 2 seconds
    res.status(200).send('EVENT_RECEIVED');

    // Iterate over each entry - there may be multiple if batched
    for (const entry of body.entry) {
      const pageId = entry.id;
      
      // Check if messaging property exists
      if (entry.messaging) {
        const webhook_event = entry.messaging[0];
        const senderPsid = webhook_event.sender.id;

        // In a real implementation, you would pass this to a service to handle
        // rule-based, OpenAI, or Human-takeover logic
        console.log(`Received event for page ${pageId} from ${senderPsid}:`, webhook_event);
        
        // Example:
        // await chatService.processEvent(pageId, senderPsid, webhook_event);
      }
    }
  } else {
    // Return a '404 Not Found' if event is not from a page subscription
    res.sendStatus(404);
  }
};
