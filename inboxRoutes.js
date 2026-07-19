const express = require('express');
const router = express.Router();
const { protect } = require('./authMiddleware');
const ChatLog = require('./ChatLog');
const Page = require('./Page');
const Customer = require('./Customer');
const facebookService = require('./facebookService');
const aiService = require('./aiService');

// এই ফাইলের সমস্ত রাউট ব্যবহার করার জন্য ব্যবহারকারীকে লগইন করা থাকতে হবে
router.use(protect);

/**
 * GET /api/inbox/conversations/:pageId
 * একটি পেজের জন্য সমস্ত কথোপকথনের তালিকা নিয়ে আসে।
 * প্রতিটি কথোপকথনের সর্বশেষ বার্তা এবং ব্যবহারকারীর নাম দেখানো হয়।
 */
router.get('/conversations/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;

    // অ্যাগ্রিগেশন পাইপলাইন ব্যবহার করে চ্যাটলগ থেকে কথোপকথন গ্রুপ করা হয়
    const conversations = await ChatLog.aggregate([
      // নির্দিষ্ট পেজের চ্যাটলগ ফিল্টার করা হয়
      { $match: { pageId } },
      // সময় অনুযায়ী সাজানো হয়
      { $sort: { timestamp: -1 } },
      // psid অনুযায়ী গ্রুপ করা হয় এবং সর্বশেষ বার্তা ও সময় নেওয়া হয়
      {
        $group: {
          _id: '$psid',
          lastMessage: { $first: '$message.text' },
          lastMessageTimestamp: { $first: '$timestamp' },
          pageId: { $first: '$pageId' },
        },
      },
      // নতুন করে সময় অনুযায়ী সাজানো হয়
      { $sort: { lastMessageTimestamp: -1 } },
      // Customer কালেকশন থেকে ব্যবহারকারীর নাম join করা হয়
      {
        $lookup: {
          from: 'customers',
          let: { psid: '$_id', pageId: '$pageId' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$psid', '$$psid'] }, { $eq: ['$pageId', '$$pageId'] }] } } },
            { $project: { name: 1, _id: 0 } }
          ],
          as: 'customerInfo'
        }
      },
      // আউটপুট ফরম্যাট করা হয়
      {
        $project: {
          psid: '$_id',
          lastMessage: 1,
          lastMessageTimestamp: 1,
          userName: { $arrayElemAt: ['$customerInfo.name', 0] },
          _id: 0,
        },
      },
    ]);

    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ message: 'Server error while fetching conversations.' });
  }
});

/**
 * GET /api/inbox/messages/:pageId/:psid
 * একটি নির্দিষ্ট ব্যবহারকারীর সাথে হওয়া সমস্ত মেসেজ নিয়ে আসে।
 */
router.get('/messages/:pageId/:psid', async (req, res) => {
  try {
    const { pageId, psid } = req.params;
    const messages = await ChatLog.find({ pageId, psid }).sort({ timestamp: 'asc' });
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ message: 'Server error while fetching messages.' });
  }
});

/**
 * POST /api/inbox/reply
 * অ্যাডমিন ড্যাশবোর্ড থেকে ব্যবহারকারীকে সরাসরি উত্তর পাঠায়।
 */
router.post('/reply', async (req, res) => {
  try {
    const { pageId, psid, message } = req.body;

    const page = await Page.findOne({ pageId, ownerId: req.user._id }).select('+pageAccessToken');
    if (!page) {
      return res.status(404).json({ message: 'Page not found or you do not have permission.' });
    }

    const pageAccessToken = facebookService.decryptToken(page.pageAccessToken);

    // Facebook API ব্যবহার করে মেসেজ পাঠানো হয়
    await facebookService.sendTextMessage(psid, message, pageAccessToken);

    // পাঠানো মেসেজটি ডেটাবেসে সংরক্ষণ করা হয় (sender হিসেবে 'bot' ব্যবহার করতে হবে কারণ স্কিমাতে 'page' নেই)
    const savedMessage = await ChatLog.create({ pageId, psid, sender: 'bot', message: { text: message } });

    res.status(201).json(savedMessage);
  } catch (error) {
    console.error('Error sending reply:', error.message);
    res.status(500).json({ message: error.message || 'Failed to send reply.' });
  }
});

/**
 * GET /api/inbox/suggest-reply/:pageId/:psid
 * AI-এর মাধ্যমে একটি সম্ভাব্য উত্তরের সাজেশন তৈরি করে।
 */
router.get('/suggest-reply/:pageId/:psid', async (req, res) => {
  try {
    const { pageId, psid } = req.params;
    
    // পেজ এক্সেস চেক
    const page = await Page.findOne({ pageId, ownerId: req.user._id });
    if (!page) {
      return res.status(403).json({ message: 'Forbidden access to this page.' });
    }

    // চ্যাট হিস্ট্রি নিয়ে আসুন (শেষ ৫টি মেসেজ)
    const recentMessages = await ChatLog.find({ pageId, psid }).sort({ timestamp: -1 }).limit(5);
    const history = recentMessages.reverse().map(log => ({
        role: log.sender === 'user' ? 'user' : 'assistant',
        content: log.message?.text || '',
    }));

    // AI এর জন্য প্রম্পট তৈরি করুন
    const systemPrompt = `You are an AI assistant helping a human customer support agent.
Based on the conversation history with this customer on Facebook page "${page.name}", suggest the NEXT logical reply that the human agent should send.
CRITICAL RULES:
1. The reply MUST be in Bengali (বাংলা).
2. Keep it professional, helpful, and concise (1-2 sentences).
3. Do NOT include any filler words, introductory phrases, or quotes. Provide ONLY the exact text the agent should copy and paste to send.`;

    // AI সার্ভিস কল করুন
    const suggestedText = await aiService.getAIResponse(systemPrompt, history);
    
    res.json({ suggestion: suggestedText });
  } catch (error) {
    console.error('Error generating AI suggestion:', error);
    res.status(500).json({ message: 'Failed to generate suggestion.' });
  }
});

module.exports = router;