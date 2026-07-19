require('dotenv').config();
const mongoose = require('mongoose');
const { processMessage } = require('./messageProcessor');

async function testProcessing() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");
    
    // Using the exact pageId and psid from the user's webhook hit!
    const jobData = {
      type: 'message',
      pageId: '1080690761800329',
      psid: '26010996855265627',
      message: {
        mid: 'test_mid_123',
        text: 'T shart er image ta daw'
      }
    };
    
    try {
        await processMessage(jobData);
        console.log("Process complete!");
    } catch (e) {
        console.error("Error in processMessage:", e);
    }
    process.exit(0);
}

testProcessing();
