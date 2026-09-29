const Page = require('./Page');
const ChatLog = require('./ChatLog');
const Product = require('./Product');
const Order = require('./Order');
const Customer = require('./Customer');
const User = require('./User');
const facebookService = require('./facebookService');
const { broadcastToPage } = require('./websocket');
const aiService = require('./aiService');
const sessionService = require('./sessionService');

const PRODUCTS_PER_CATALOG_PAGE = 3;

const sendProductCatalogPage = async (psid, pageId, pageAccessToken, pageNumber = 0) => {
    const safePageNumber = Number.isInteger(pageNumber) && pageNumber >= 0 ? pageNumber : 0;
    const [products, totalProducts] = await Promise.all([
        Product.find({ pageId }).sort({ createdAt: -1 }).skip(safePageNumber * PRODUCTS_PER_CATALOG_PAGE).limit(PRODUCTS_PER_CATALOG_PAGE),
        Product.countDocuments({ pageId }),
    ]);
    if (products.length === 0) return false;

    const hasMoreProducts = totalProducts > (safePageNumber + 1) * PRODUCTS_PER_CATALOG_PAGE;
    const elements = products.map((product, index) => {
        const buttons = [
            { type: 'postback', title: 'Buy Now', payload: `BUY_${product._id}` },
            { type: 'web_url', url: 'https://your-website.com/contact', title: 'Contact Us' },
        ];
        if (hasMoreProducts && index === products.length - 1) {
            buttons.push({ type: 'postback', title: 'See More Products', payload: `SHOW_MORE_PRODUCTS_${safePageNumber + 1}` });
        }
        return {
            title: product.name,
            subtitle: `Price: ${product.price} BDT\nStock: ${product.stock}`,
            image_url: product.imageUrl,
            buttons,
        };
    });

    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
    return true;
};

const processMessage = async (jobData) => {
    const { type, pageId, psid, message, postback } = jobData;

    // ধাপ ১: পেজের তথ্য এবং অ্যাক্সেস টোকেন আনুন
    const page = await Page.findOne({ pageId }).select('+pageAccessToken +humanTakeover +aiSystemPrompt');
    if (!page) {
        console.error(`Page with ID ${pageId} not found.`);
        return false; // প্রসেসিং ব্যর্থ
    }
    const pageAccessToken = facebookService.decryptToken(page.pageAccessToken);

    // ধাপ ১.১: অ্যাটাচমেন্ট (ছবি) হ্যান্ডেল করুন
    if (type === 'message' && message.attachments && message.attachments.length > 0) {
        const attachment = message.attachments[0];
        if (attachment.type === 'image' && !page.humanTakeover) {
            console.log(`[Visual Search] Received image from user ${psid}. URL: ${attachment.payload.url}`);

            const catalogProducts = await Product.find({ pageId, imageUrl: { $exists: true, $ne: '' } })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean();
            const verifiedProducts = await aiService.findExactVisualMatches(attachment.payload.url, catalogProducts);

            if (verifiedProducts.length > 0) {
                await facebookService.sendTextMessage(psid, "\u0986\u09aa\u09a8\u09be\u09b0 \u099b\u09ac\u09bf\u09b0 \u09b8\u09be\u09a5\u09c7 \u09a8\u09bf\u09b6\u09cd\u099a\u09bf\u09a4\u09ad\u09be\u09ac\u09c7 \u09ae\u09c7\u09b2\u09be \u09aa\u09a3\u09cd\u09af\u0997\u09c1\u09b2\u09cb \u09a8\u09bf\u099a\u09c7 \u09a6\u09c7\u0993\u09df\u09be \u09b9\u09b2\u09cb:", pageAccessToken);
                const elements = verifiedProducts.map(p => ({
                    title: p.name,
                    subtitle: `Price: ${p.price} BDT`,
                    image_url: p.imageUrl,
                    buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                }));
                await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
            } else {
                await facebookService.sendTextMessage(psid, "\u09a6\u09c1\u0983\u0996\u09bf\u09a4, \u099b\u09ac\u09bf\u099f\u09bf\u09b0 \u09b8\u09be\u09a5\u09c7 catalog-\u098f\u09b0 \u0995\u09cb\u09a8\u09cb \u09a8\u09bf\u09b6\u09cd\u099a\u09bf\u09a4 \u09ae\u09bf\u09b2 \u09aa\u09be\u0993\u09df\u09be \u09af\u09be\u09df\u09a8\u09bf\u0964 \u09ad\u09c1\u09b2 product \u09a6\u09c7\u0996\u09be\u09a8\u09cb\u09b0 \u09aa\u09b0\u09bf\u09ac\u09b0\u09cd\u09a4\u09c7 \u0986\u09aa\u09a8\u09bf product code \u0985\u09a5\u09ac\u09be \u0986\u09b0\u0993 \u09aa\u09b0\u09bf\u09b7\u09cd\u0995\u09be\u09b0 \u099b\u09ac\u09bf \u09aa\u09be\u09a0\u09be\u09a4\u09c7 \u09aa\u09be\u09b0\u09c7\u09a8\u0964", pageAccessToken);
            }
            return true;
            
            // ১. ছবি থেকে সার্চের জন্য বর্ণনা তৈরি করুন
            const searchKeywords = await aiService.getImageDescriptionForSearch(attachment.payload.url);
            console.log(`[Visual Search] Keywords from AI: "${searchKeywords}"`);

            if (searchKeywords) {
                // ২. ডাটাবেসে Atlas Search ব্যবহার করে সার্চ করুন
                const matchedProducts = await Product.aggregate([
                    {
                        $search: {
                            index: 'product_search', // Atlas UI-তে তৈরি করা ইনডেক্সের নাম
                            text: {
                                query: searchKeywords,
                                path: ['name', 'description'], // যে ফিল্ডগুলোতে সার্চ করতে হবে
                                fuzzy: { // টাইপো বা ছোটখাটো ভুল বানান ঠিক করার জন্য
                                    maxEdits: 1,
                                    prefixLength: 2
                                }
                            }
                        }
                    },
                    {
                        $match: { pageId: pageId } // সার্চ ফলাফলের পর পেজ আইডি দিয়ে ফিল্টার করুন
                    },
                    { $limit: 5 }, // ফলাফলের সংখ্যা ৫-এর মধ্যে সীমাবদ্ধ রাখুন
                    { $addFields: { score: { $meta: "searchScore" } } } // প্রাসঙ্গিকতা স্কোর যোগ করুন (ঐচ্ছিক)
                ]);

                if (matchedProducts.length > 0) {
                    // ৩. ম্যাচ পাওয়া গেলে
                    await facebookService.sendTextMessage(psid, "আপনার পাঠানো ছবির সাথে মিলে যাওয়া কিছু পণ্য নিচে দেওয়া হলো:", pageAccessToken);
                    const elements = matchedProducts.map(p => ({
                        title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: p.imageUrl,
                        buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                    }));
                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                } else {
                    // ৪. ম্যাচ না পাওয়া গেলে
                    await facebookService.sendTextMessage(psid, "দুঃখিত, আপনার পাঠানো ছবির পণ্যটি আমাদের সংগ্রহে নেই। তবে, আমাদের অন্যান্য জনপ্রিয় কিছু পণ্য নিচে দেখুন:", pageAccessToken);
                    const otherProducts = await Product.find({ pageId: pageId }).sort({ createdAt: -1 }).limit(5);
                    if (otherProducts.length > 0) {
                        const elements = otherProducts.map(p => ({
                            title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: p.imageUrl,
                            buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                        }));
                        await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                    }
                }
            }
            return true; // ছবি প্রসেস করা শেষ
        }
    }

    // পোস্টব্যাক বা মেসেজ থেকে টেক্সট নিন
    const incomingMessageText = type === 'message' && message.text
        ? message.text.toLowerCase().trim() 
        : (postback && postback.payload ? postback.payload : '');

    // Redis থেকে বর্তমান ব্যবহারকারীর সেশন আনুন
    const userSession = await sessionService.getSession(psid) || {};

    // যদি Human Takeover সক্রিয় থাকে, তাহলে বট কোনো উত্তর দেবে না
    if (page.humanTakeover) {
        console.log(`Human takeover is active for page ${pageId}. Bot is silent.`);
        return true; // সফলভাবে প্রসেসড, কিন্তু কোনো উত্তর নেই
    }

    // ধাপ ১.২: AI ব্যবহার করে ইন্টেন্ট এবং এনটিটি সনাক্ত করুন
    const { intent, entities, confidence } = await aiService.getIntentAndEntities(incomingMessageText);
    console.log(`[AI Intent] Intent: ${intent}, Entities: ${JSON.stringify(entities)}, Confidence: ${confidence}`);

    // ব্যবহারকারীর মেসেজটি চ্যাট লগে সংরক্ষণ করুন
    if (type === 'message') {
        const savedMessage = await ChatLog.create({ pageId, psid, sender: 'user', message: { text: message.text } });
        // নতুন মেসেজ ব্রডকাস্ট করুন
        broadcastToPage(pageId, savedMessage);
    }

    let replyText = ''; // replyText-কে একটি খালি স্ট্রিং দিয়ে শুরু করুন

    // ধাপ ১.৫: যেকোনো পর্যায়ে অর্ডার বাতিল করার সুযোগ
    if (userSession.state && incomingMessageText === 'cancel') {
        await sessionService.deleteSession(psid);
        replyText = 'আপনার অর্ডার প্রক্রিয়াটি বাতিল করা হয়েছে। নতুন করে শুরু করতে "products" লিখে পাঠান।';
        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
        return true; // সফলভাবে প্রসেসড
    }

    // ধাপ ২: নিয়ম-ভিত্তিক রাউটিং এর জন্য একটি রাউটার তৈরি করুন
    const messageRouter = [
        // অর্ডার ফ্লো
        { // ইন্টেন্ট: start_order অথবা BUY_ পোস্টব্যাক
            condition: () => incomingMessageText.startsWith('BUY_'),
            action: async () => {
                const productId = incomingMessageText.split('_')[1];
                userSession.state = 'awaiting_name';
                userSession.order = { productId: productId };
                await sessionService.setSession(psid, userSession);
                return 'এই পণ্যটি অর্ডার করতে, অনুগ্রহ করে আপনার সম্পূর্ণ নাম লিখুন।';
            }
        },
        { // ইন্টেন্ট: provide_contact_info (নাম)
            condition: () => userSession.state === 'awaiting_name',
            action: async () => {
                userSession.order.customerName = entities.customerName || incomingMessageText;
                userSession.state = 'awaiting_phone';
                await sessionService.setSession(psid, userSession);

                if (entities.phone) {
                    return await processNextState(psid, userSession, entities.phone, pageAccessToken);
                }
                return 'ধন্যবাদ! এখন আপনার ফোন নম্বরটি দিন (যেমন: 01xxxxxxxxx)।';
            }
        },
        { // ইন্টেন্ট: provide_contact_info (ফোন)
            condition: () => userSession.state === 'awaiting_phone',
            action: async () => {
                const phoneToValidate = entities.phone || incomingMessageText;
                const phoneRegex = /^(?:\+88|88)?(01[3-9]\d{8})$/;
                const match = phoneToValidate.match(phoneRegex);
                if (match) {
                    const formattedPhone = `+88${match[1]}`;
                    userSession.order.phone = formattedPhone;
                    userSession.state = 'awaiting_address';
                    await sessionService.setSession(psid, userSession);

                    if (entities.address) {
                        return await processNextState(psid, userSession, entities.address, pageAccessToken);
                    }
                    return 'খুব ভালো! সবশেষে, আপনার সম্পূর্ণ ডেলিভারি ঠিকানাটি লিখুন।';
                } else {
                    return 'দুঃখিত, ফোন নম্বরটি সঠিক নয়। অনুগ্রহ করে একটি সঠিক বাংলাদেশী ফোন নম্বর দিন (যেমন: 01xxxxxxxxx)।';
                }
            }
        },
        {
            // ইন্টেন্ট: provide_contact_info (ঠিকানা)
            condition: () => userSession.state === 'awaiting_address',
            action: async () => {
                userSession.order.address = entities.address || incomingMessageText;
                const product = await Product.findById(userSession.order.productId);
                if (!product) {
                    await sessionService.deleteSession(psid);
                    return 'দুঃখিত, এই পণ্যটি আর উপলব্ধ নেই।';
                }
                const customer = await Customer.findOneAndUpdate(
                    { psid: psid, pageId: pageId },
                    { name: userSession.order.customerName, phone: userSession.order.phone, address: userSession.order.address },
                    { upsert: true, new: true }
                );
                const newOrder = new Order({
                    pageId: pageId, customerId: customer._id,
                    products: [{ productId: product._id, quantity: 1, price: product.price }],
                    totalAmount: product.price, status: 'pending',
                    shippingAddress: userSession.order.address,
                    customerInfo: { name: userSession.order.customerName, phone: userSession.order.phone },
                });
                await newOrder.save();
                await sessionService.deleteSession(psid);
                return `আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে! আপনার অর্ডার আইডি হলো: ${newOrder._id}। আমাদের একজন প্রতিনিধি শীঘ্রই আপনার সাথে যোগাযোগ করবে।`;
            }
        },
        // অন্যান্য কীওয়ার্ড
        {
            condition: () => intent === 'cancel_order' || incomingMessageText.startsWith('CANCEL_ORDER_'),
            action: async () => {
                const orderId = incomingMessageText.split('_')[1];
                const order = await Order.findById(orderId);
                if (order && (order.status === 'pending' || order.status === 'confirmed')) {
                    order.status = 'cancelled';
                    await order.save();
                    return `আপনার অর্ডার (ID: ${orderId}) সফলভাবে বাতিল করা হয়েছে।`;
                } else {
                    return `দুঃখিত, এই অর্ডারটি আর বাতিল করা সম্ভব নয়।`;
                }
            }
        },
        {
            condition: () => intent === 'track_order',
            action: async () => {
                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                if (!customer) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি। নতুন অর্ডার করতে "products" লিখে পাঠান।';
                
                const latestOrder = await Order.findOne({ customerId: customer._id }).sort({ createdAt: -1 });
                if (!latestOrder) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি।';

                const orderInfoText = `আপনার সর্বশেষ অর্ডারের তথ্য নিচে দেওয়া হলো:\n\n` +
                                    `অর্ডার আইডি: ${latestOrder._id}\n` +
                                    `মোট পরিমাণ: ${latestOrder.totalAmount} BDT\n` +
                                    `স্ট্যাটাস: ${latestOrder.status}`;

                if (latestOrder.status === 'pending' || latestOrder.status === 'confirmed') {
                    const buttons = [{ type: 'postback', title: 'Cancel Order', payload: `CANCEL_ORDER_${latestOrder._id}` }];
                    await facebookService.sendButtonTemplate(psid, orderInfoText, buttons, pageAccessToken);
                    return null; // যেহেতু একটি টেমপ্লেট পাঠানো হয়েছে, তাই কোনো টেক্সট রিপ্লাই নেই
                }
                return orderInfoText;
            }
        },
        {
            condition: () => incomingMessageText.startsWith('SHOW_MORE_PRODUCTS_'),
            action: async () => {
                const pageNumber = Number(incomingMessageText.replace('SHOW_MORE_PRODUCTS_', ''));
                const sent = await sendProductCatalogPage(psid, pageId, pageAccessToken, pageNumber);
                return sent ? null : "\u09a6\u09c1\u0983\u0996\u09bf\u09a4, \u09a6\u09c7\u0996\u09be\u09a8\u09cb\u09b0 \u09ae\u09a4\u09cb \u0986\u09b0 \u0995\u09cb\u09a8\u09cb product \u09a8\u09c7\u0987\u0964";
            }
        },
        {
            condition: () => intent === 'show_product_images',
            action: async () => {
                const products = await Product.find({ pageId, imageUrl: { $exists: true, $ne: '' } }).limit(50);
                const searchQuery = entities.productName || incomingMessageText;
                const matchedProducts = await aiService.findBestMatchingProducts(searchQuery, products);
                const images = matchedProducts
                    .flatMap(product => product.imageUrls?.length ? product.imageUrls : [product.imageUrl])
                    .filter(Boolean)
                    .slice(0, 4);

                if (images.length === 0) {
                    return "\u09a6\u09c1\u0983\u0996\u09bf\u09a4, \u098f\u0987 product-\u098f\u09b0 \u0995\u09cb\u09a8\u09cb \u099b\u09ac\u09bf \u0986\u09ae\u09be\u09a6\u09c7\u09b0 \u09b8\u0982\u0997\u09cd\u09b0\u09b9\u09c7 \u09aa\u09be\u0993\u09df\u09be \u09af\u09be\u09df\u09a8\u09bf\u0964";
                }

                for (const imageUrl of images) {
                    await facebookService.sendImageMessage(psid, imageUrl, pageAccessToken);
                }
                return null;
            }
        },
        {
            condition: () => intent === 'show_products',
            action: async () => {
                const sent = await sendProductCatalogPage(psid, pageId, pageAccessToken);
                if (sent) return null;
                return "\u09a6\u09c1\u0983\u0996\u09bf\u09a4, \u098f\u0987 \u09ae\u09c1\u09b9\u09c2\u09b0\u09cd\u09a4\u09c7 \u09a6\u09cb\u0995\u09be\u09a8\u09c7 \u0995\u09cb\u09a8\u09cb product \u0989\u09aa\u09b2\u09ac\u09cd\u09a7 \u09a8\u09c7\u0987\u0964";
                const products = await Product.find({ pageId }).limit(10);
                if (products && products.length > 0) {
                    const elements = products.map(p => ({
                        title: p.name, subtitle: `Price: ${p.price} BDT\nStock: ${p.stock}`, image_url: p.imageUrl,
                        buttons: [
                            { type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` },
                            { type: 'web_url', url: 'https://your-website.com/contact', title: 'Contact Us' },
                        ],
                    }));
                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                    return null; // টেমপ্লেট পাঠানো হয়েছে
                }
                return 'দুঃখিত, এই মুহূর্তে দোকানে কোনো পণ্য উপলব্ধ নেই।';
            }
        },
    ];

    for (const rule of messageRouter) {
        if (rule.condition()) {
            replyText = await rule.action();
            break; // প্রথম ম্যাচ করা রুলেই থেমে যান
        }
    }

    // ধাপ ৩: AI-ভিত্তিক ফলব্যাক
    if ((replyText === '' && !userSession.state) || intent === 'general_question') {
        const queryForAI = incomingMessageText;
        console.log(`Forwarding to AI with query: "${queryForAI}"`);

        // কথোপকথনের ইতিহাস তৈরি করুন
        const recentMessages = await ChatLog.find({ pageId, psid })
            .sort({ timestamp: -1 })
            .limit(10);
        
        const history = recentMessages.reverse().map(log => ({
            role: log.sender === 'user' ? 'user' : 'assistant',
            content: log.message?.text || '(Attachment or unknown message)',
        }));

        // ডাটাবেস থেকে প্রোডাক্টগুলো আনুন যাতে এআই জানে কী কী প্রোডাক্ট আছে
        const products = await Product.find({ pageId }).limit(20);
        let productContext = "";
        if (products && products.length > 0) {
            productContext = "\n\n--- আপনার দোকানের বর্তমান প্রোডাক্ট তালিকা ---\n";
            products.forEach(p => {
                productContext += `- ${p.name} (দাম: ${p.price} BDT, স্টক: ${p.stock})\n`;
                if (p.description) productContext += `  বিবরণ: ${p.description}\n`;
            });
            productContext += "\nকাস্টমার যদি কোনো প্রোডাক্ট বা দাম সম্পর্কে জানতে চায়, উপরের তালিকা থেকে তথ্য দেবে। যদি বিস্তারিত ছবি দেখতে চায়, তবে কাস্টমারকে 'products' শব্দটি লিখে সেন্ড করতে বলবে, তাহলে সিস্টেম অটোমেটিক ছবিসহ প্রোডাক্ট পাঠাবে।";
        }

        // কাস্টম প্রম্পট থেকে [আপনার পেজের নাম] লেখাটি রিপ্লেস করে আসল পেজের নাম বসিয়ে দিন
        let systemPromptText = page.aiSystemPrompt || "";
        systemPromptText = systemPromptText.replace(/\[আপনার পেজের নাম\]/g, page.name);

        const baseIdentity = "Your name is Snigda (স্নিগ্ধা). You must politely introduce yourself as Snigda in Bengali when a user says 'hi', 'hello', or asks for your name. CRITICAL RULE: NEVER start your response with the shop's name as a header or title. Write naturally like a human in a chat message.";

        const finalPrompt = `${systemPromptText}\n${productContext}\n\n${baseIdentity}`;

        replyText = await aiService.getAIResponse(finalPrompt, [...history, { role: 'user', content: queryForAI }]);

        // AI রেসপন্স কাউন্ট বৃদ্ধি করুন
        try {
            if (page.ownerId) {
                await User.findByIdAndUpdate(page.ownerId, {
                    $inc: { 'subscriptionPlan.aiResponsesUsed': 1 }
                });
            }
        } catch (err) {
            console.error('Failed to increment AI response count:', err);
        }
    }

    // ধাপ ৪: ব্যবহারকারীকে উত্তর পাঠান
    if (replyText) {
        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
        // বটের উত্তর চ্যাট লগে সংরক্ষণ করুন
        const botMessage = await ChatLog.create({ pageId, psid, sender: 'bot', message: { text: replyText } });
        // বটের উত্তর ব্রডকাস্ট করুন
        broadcastToPage(pageId, botMessage);
        return true; // সফলভাবে প্রসেসড
    }

    console.log(`[Processor] No reply generated for message: "${incomingMessageText}". Current session state: ${userSession.state || 'none'}.`);
    return true;
};

module.exports = { processMessage };
