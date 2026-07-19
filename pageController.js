const Page = require('./Page');
const facebookService = require('./facebookService');
const { protect } = require('./authMiddleware');
const User = require('./User'); // User মডেল ইম্পোর্ট করুন

exports.subscribePage = async (req, res) => {
    const { pageId } = req.params;
    const userId = req.user.id;

    try {
        // ব্যবহারকারীর প্ল্যান এবং বর্তমান অ্যাক্টিভ পেজের সংখ্যা চেক করুন
        const user = await User.findById(userId);
        const planLimit = user.subscriptionPlan?.pageLimit || 1; // ডিফল্ট লিমিট ১

        const activePagesCount = await Page.countDocuments({ ownerId: userId, isSubscribed: true });

        // যদি লিমিট শেষ হয়ে যায়, তাহলে এরর দিন
        if (activePagesCount >= planLimit) {
            return res.status(403).json({ 
                success: false, 
                message: `You have reached your limit of ${planLimit} page(s) for your current plan. Please upgrade to add more pages.` 
            });
        }

        // পেজটি খুঁজুন
        const page = await Page.findOne({ pageId }).select('+pageAccessToken');
        if (!page) {
            return res.status(404).send('Page not found or not connected to your account.');
        }

        // ডিক্রিপ্ট করা টোকেন ব্যবহার করে সাবস্ক্রাইব করুন
        const decryptedPageToken = facebookService.decryptToken(page.pageAccessToken);
        await facebookService.subscribePageToWebhook(pageId, decryptedPageToken);
        
        // Setup Messenger Profile (Persistent Menu, Get Started button)
        await facebookService.setupMessengerProfile(decryptedPageToken);
        
        page.isSubscribed = true;
        await page.save();

        res.status(200).json({ success: true, message: `Page "${page.name}" subscribed successfully.` });
    } catch (error) {
        console.error('Error in page subscription controller:', error);
        res.status(500).json({ success: false, message: 'Failed to subscribe page.' });
    }
};

/**
 * একটি পেজকে ওয়েবহুক থেকে আনসাবস্ক্রাইব করে
 */
exports.unsubscribePage = async (req, res) => {
    const { pageId } = req.params;
    try {
        const page = await Page.findOne({ pageId }).select('+pageAccessToken');
        if (!page) {
            return res.status(404).send('Page not found.');
        }
        const decryptedPageToken = facebookService.decryptToken(page.pageAccessToken);
        await facebookService.unsubscribePageFromWebhook(pageId, decryptedPageToken);
        
        page.isSubscribed = false;
        await page.save();
        
        res.status(200).json({ success: true, message: `Page "${page.name}" unsubscribed successfully.` });
    } catch (error) {
        console.error('Error in page unsubscription controller:', error);
        res.status(500).json({ success: false, message: 'Failed to unsubscribe page.' });
    }
};

/**
 * একটি নির্দিষ্ট পেজের কনফিগারেশন (যেমন: aiSystemPrompt) আপডেট করে।
 */
exports.updatePageConfig = async (req, res) => {
    try {
        const { pageId } = req.params;
        const { aiSystemPrompt, businessType, useDefaultPrompt } = req.body;
        const userId = req.user._id;

        const updateFields = {};
        if (aiSystemPrompt !== undefined) updateFields.aiSystemPrompt = aiSystemPrompt;
        if (businessType !== undefined) updateFields.businessType = businessType;
        if (useDefaultPrompt !== undefined) updateFields.useDefaultPrompt = useDefaultPrompt;

        // পেজের মালিকানা যাচাই করুন এবং আপডেট করুন
        const updatedPage = await Page.findOneAndUpdate(
            { pageId: pageId, ownerId: userId },
            { $set: updateFields },
            { new: true }
        );

        if (!updatedPage) {
            return res.status(404).json({ message: "Page not found or you don't have permission." });
        }

        res.status(200).json({ message: 'Page configuration updated successfully.', page: updatedPage });
    } catch (error) {
        console.error("Error updating page config:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * ডিবাগিং এর জন্য একটি পেজের টোকেন সার্ভার টার্মিনালে লগ করে।
 */
exports.debugToken = async (req, res) => {
    const { pageId } = req.params;
    const userId = req.user.id;

    try {
        const page = await Page.findOne({ pageId, ownerId: userId }).select('+pageAccessToken');
        if (!page) {
            return res.status(404).send('Page not found.');
        }

        console.log(`\n--- DEBUG: Token for page "${page.name}" (${pageId}) ---`);
        console.log('Encrypted Token:', page.pageAccessToken);
        try {
            const decryptedToken = facebookService.decryptToken(page.pageAccessToken);
            console.log('Decrypted Token (first 15 chars):', decryptedToken.substring(0, 15) + '...');
        } catch (e) {
            console.error('Could not decrypt token:', e.message);
        }
        console.log('----------------------------------------------------\n');

        res.status(200).json({ success: true, message: 'Token info logged on server.' });
    } catch (error) {
        console.error('Error in debugToken controller:', error);
        res.status(500).json({ success: false, message: 'Failed to log token.' });
    }
};

/**
 * একটি নির্দিষ্ট পেজের জন্য 'Human Takeover' মোড টগল করে।
 */
exports.toggleHumanTakeover = async (req, res) => {
    try {
        const { pageId } = req.params;
        const { humanTakeover } = req.body;
        const userId = req.user._id; // authMiddleware থেকে প্রাপ্ত

        if (typeof humanTakeover !== 'boolean') {
            return res.status(400).json({ message: 'A boolean "humanTakeover" field is required.' });
        }

        // পেজের মালিকানা যাচাই করুন এবং humanTakeover স্ট্যাটাস আপডেট করুন
        const updatedPage = await Page.findOneAndUpdate(
            { pageId: pageId, ownerId: userId },
            { $set: { humanTakeover: humanTakeover } },
            { new: true }
        );

        if (!updatedPage) {
            return res.status(404).json({ message: "Page not found or you don't have permission." });
        }

        res.status(200).json({ message: `Human takeover mode set to ${humanTakeover}.`, page: updatedPage });
    } catch (error) {
        console.error("Error toggling human takeover:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * Generates AI business rules and appends them to the page's custom prompt.
 */
exports.generateBusinessRules = async (req, res) => {
    try {
        const { pageId } = req.params;
        const { businessType, currentPrompt } = req.body;
        const userId = req.user._id;

        if (!businessType) {
            return res.status(400).json({ message: 'businessType is required.' });
        }

        const page = await Page.findOne({ pageId: pageId, ownerId: userId });
        if (!page) {
            return res.status(404).json({ message: "Page not found or you don't have permission." });
        }

        const aiService = require('./aiService');
        
        let promptBase = currentPrompt || page.aiSystemPrompt;
        if (page.useDefaultPrompt && !currentPrompt) {
            const SystemSetting = require('./SystemSetting');
            const defaultPromptSetting = await SystemSetting.findOne({ key: 'DEFAULT_AI_PROMPT' });
            if (defaultPromptSetting && defaultPromptSetting.value) {
                promptBase = defaultPromptSetting.value;
            }
        }

        const generatedRules = await aiService.generateBusinessRules(businessType, promptBase || '');
        
        const newPrompt = (promptBase ? promptBase + '\n\n' : '') + generatedRules;

        const updatedPage = await Page.findOneAndUpdate(
            { pageId: pageId, ownerId: userId },
            { 
                $set: { 
                    aiSystemPrompt: newPrompt,
                    businessType: businessType,
                    useDefaultPrompt: false 
                } 
            },
            { new: true }
        );

        res.status(200).json({ 
            message: 'Business rules generated and saved successfully.', 
            page: updatedPage 
        });

    } catch (error) {
        console.error("Error generating business rules:", error);
        res.status(500).json({ message: "Failed to generate business rules. Please try again later." });
    }
};