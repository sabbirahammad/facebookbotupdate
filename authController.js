const User = require('./User');
const Page = require('./Page');
const jwt = require('jsonwebtoken');
const facebookService = require('./facebookService');

// ব্যবহারকারীকে ফেসবুক লগইন ডায়ালগে রিডাইরেক্ট করে
exports.initiateFacebookAuth = (req, res) => {
    const scopes = [
        'public_profile',
        'email',
        'pages_show_list',
        'pages_messaging',
        'pages_read_engagement', // To read page content and follower data
        'pages_manage_metadata', // To manage page settings and webhooks
        'business_management'    // Often required for managing business assets like Pages
    ].join(',');

    const redirectURI = `${process.env.SERVER_URL}/auth/facebook/callback`;
    const clientId = process.env.META_APP_ID;
    const authURL = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${clientId}&redirect_uri=${redirectURI}&scope=${scopes}&response_type=code`;
    
    console.log("--- Redirecting to Facebook with URL:", authURL);
    res.redirect(authURL);
};

// ফেসবুক থেকে কলব্যাক পরিচালনা করে
exports.handleFacebookCallback = async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('Authorization code not found.');
    }

    try {
        // ধাপ ১: কোডকে একটি শর্ট-লিভড টোকেনের জন্য এক্সচেঞ্জ করুন
        const shortLivedToken = await facebookService.exchangeCodeForAccessToken(code);

        // ধাপ ২: শর্ট-লিভড টোকেনকে একটি লং-লিভড টোকেনে রূপান্তর করুন
        const longLivedUserToken = await facebookService.getLongLivedUserToken(shortLivedToken);

        // ধাপ ২: ব্যবহারকারীর প্রোফাইল এবং পেজ তথ্য আনুন
        const { profile, pages } = await facebookService.getUserProfileAndPages(longLivedUserToken);

        // ধাপ ৩: ডাটাবেসে ব্যবহারকারী তৈরি বা আপডেট করুন
        let user = await User.findOneAndUpdate(
            { facebookId: profile.id },
            {
                name: profile.name,
                email: profile.email,
                facebookId: profile.id,
                // শুধুমাত্র নতুন ব্যবহারকারী তৈরি করার সময় ডিফল্ট প্ল্যান ও রোল সেট হবে
                $setOnInsert: { // শুধুমাত্র নতুন ব্যবহারকারী তৈরি করার সময় ডিফল্ট প্ল্যান সেট হবে
                    'subscriptionPlan.name': 'basic',
                    'subscriptionPlan.pageLimit': 1,
                },
                accessToken: facebookService.encryptToken(longLivedUserToken),
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // ধাপ ৪: ব্যবহারকারীর পেজগুলো ডাটাবেসে সেভ/আপডেট করুন
        const pageUpdatePromises = pages.map(pageData => 
            Page.findOneAndUpdate(
                { pageId: pageData.id },
                {
                    ownerId: user._id,
                    pageId: pageData.id,
                    name: pageData.name,
                    pageAccessToken: facebookService.encryptToken(pageData.access_token)
                },
                { upsert: true, new: true }
            )
        );
        await Promise.all(pageUpdatePromises);
        
        // ধাপ ৫: ব্যবহারকারীর জন্য একটি JWT তৈরি করুন
        const token = jwt.sign(
            { id: user._id, name: user.name, facebookId: user.facebookId },
            process.env.JWT_SECRET,
            { expiresIn: '7d' } // টোকেনটি ৭ দিন পর এক্সপায়ার হয়ে যাবে
        );

        // ধাপ ৬: টোকেন সহ ফ্রন্টএন্ড ড্যাশবোর্ডে রিডাইরেক্ট করুন
        res.redirect(`${process.env.FRONTEND_URL}/dashboard?token=${token}`);
    } catch (error) {
        console.error('Facebook auth callback error:', error);
        res.status(500).send('An error occurred during Facebook authentication.');
    }
};