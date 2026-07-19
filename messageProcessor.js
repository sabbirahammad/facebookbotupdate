const Page = require('./Page');
const ChatLog = require('./ChatLog');
const Product = require('./Product');
const Order = require('./Order');
const Customer = require('./Customer');
const QuickReply = require('./QuickReply');
const facebookService = require('./facebookService');
const { broadcastToPage } = require('./websocket');
const aiService = require('./aiService');
const sessionService = require('./sessionService');
const User = require('./User');
const SystemSetting = require('./SystemSetting');

const getPublicImageUrl = (url) => {
    if (!url) return url;
    if (url.includes('localhost')) {
        return url.replace(/https?:\/\/localhost:\d+/, process.env.SERVER_URL);
    }
    return url;
};

const processMessage = async (jobData) => {
    const { type, pageId, psid, message, postback } = jobData;

    // ধাপ ১: পেজের তথ্য এবং অ্যাক্সেস টোকেন আনুন
    const page = await Page.findOne({ pageId }).select('+pageAccessToken');
    if (!page) {
        console.error(`Page with ID ${pageId} not found.`);
        return false; // প্রসেসিং ব্যর্থ
    }
    const pageAccessToken = facebookService.decryptToken(page.pageAccessToken);

    // যদি পেজটি সাবস্ক্রাইব করা না থাকে, তাহলে বট কোনো উত্তর দেবে না
    if (!page.isSubscribed) {
        console.log(`Page ${pageId} is not subscribed. Bot is ignoring the message.`);
        return true; 
    }

    // লিমিট এনফোর্সমেন্ট: ইউজারের প্ল্যান লিমিট চেক করুন
    const user = await User.findById(page.ownerId);
    const planLimit = user?.subscriptionPlan?.pageLimit || 1;
    const activeSubscribedPages = await Page.find({ ownerId: page.ownerId, isSubscribed: true }).sort({ updatedAt: 1 });
    const validSubscribedPageIds = activeSubscribedPages.slice(0, planLimit).map(p => p.pageId);
    
    if (!validSubscribedPageIds.includes(pageId)) {
        console.log(`Page ${pageId} is over the user's subscription limit (${planLimit}). Bot is ignoring the message.`);
        return true;
    }

    // যদি Human Takeover সক্রিয় থাকে, তাহলে বট কোনো উত্তর দেবে না
    if (page.humanTakeover) {
        console.log(`Human takeover is active for page ${pageId}. Bot is silent.`);
        return true; // সফলভাবে প্রসেসড, কিন্তু কোনো উত্তর নেই
    }

    // মেসেজ 'Seen' (দেখা হয়েছে) মার্ক করুন
    await facebookService.sendSenderAction(psid, 'mark_seen', pageAccessToken);
    
    // API রেট লিমিট এড়াতে ছোট একটি বিরতি (২০০ মিলিসেকেন্ড)
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // এরপর টাইপিং অ্যানিমেশন চালু করুন (অপেক্ষা করার দরকার নেই, AI প্রসেস হতে যে সময় লাগবে তাতেই টাইপিং দেখাবে)
    await facebookService.sendTypingOn(psid, pageAccessToken);

    // ধাপ ১.১: অ্যাটাচমেন্ট (ছবি) হ্যান্ডেল করুন
    if (type === 'message' && message.attachments && message.attachments.length > 0) {
        const attachment = message.attachments[0];
        if (attachment.type === 'image') {
            console.log(`[Visual Search] Received image from user ${psid}. URL: ${attachment.payload.url}`);
            
            // ১. ছবি থেকে সার্চের জন্য বর্ণনা তৈরি করুন
            const searchKeywords = await aiService.getImageDescriptionForSearch(attachment.payload.url);
            console.log(`[Visual Search] Keywords from AI: "${searchKeywords}"`);

            if (searchKeywords) {
                // ২. AI দিয়ে প্রোডাক্ট ম্যাচ করানো
                const allProducts = await Product.find({ pageId: pageId });
                const matchedProducts = await aiService.findBestMatchingProducts(searchKeywords, allProducts);

                if (matchedProducts.length > 0) {
                    // ৩. ম্যাচ পাওয়া গেলে
                    await facebookService.sendTextMessage(psid, "আপনার পাঠানো ছবির সাথে মিলে যাওয়া কিছু পণ্য নিচে দেওয়া হলো:", pageAccessToken);
                    const elements = matchedProducts.map(p => ({
                        title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: getPublicImageUrl(p.imageUrl),
                        buttons: [
                            { type: 'postback', title: '🛒 অর্ডার করুন / কিনুন', payload: `BUY_${p._id}` },
                            { type: 'web_url', url: `https://your-website.com/product/${p._id}`, title: '📝 বিস্তারিত দেখুন' }
                        ],
                    }));
                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                } else {
                    // ৪. ম্যাচ না পাওয়া গেলে
                    await facebookService.sendTextMessage(psid, "দুঃখিত, আপনার পাঠানো ছবির পণ্যটি আমাদের সংগ্রহে নেই। তবে, আমাদের অন্যান্য জনপ্রিয় কিছু পণ্য নিচে দেখুন:", pageAccessToken);
                    const otherProducts = await Product.find({ pageId: pageId }).sort({ createdAt: -1 }).limit(5);
                    if (otherProducts.length > 0) {
                        const elements = otherProducts.map(p => ({
                            title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: getPublicImageUrl(p.imageUrl),
                            buttons: [
                                { type: 'postback', title: '🛒 অর্ডার করুন / কিনুন', payload: `BUY_${p._id}` },
                                { type: 'web_url', url: `https://your-website.com/product/${p._id}`, title: '📝 বিস্তারিত দেখুন' }
                            ],
                        }));
                        await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                    }
                }
            }
            return true; // ছবি প্রসেস করা শেষ
        }
    }

    // পোস্টব্যাক বা মেসেজ থেকে টেক্সট নিন
    let incomingMessageText = '';
    if (type === 'message') {
        if (message.quick_reply && message.quick_reply.payload) {
            incomingMessageText = message.quick_reply.payload.toLowerCase().trim();
        } else if (message.text) {
            incomingMessageText = message.text.toLowerCase().trim();
        }
    } else if (postback && postback.payload) {
        incomingMessageText = postback.payload.toLowerCase().trim();
    }

    // Redis থেকে বর্তমান ব্যবহারকারীর সেশন আনুন
    // Redis থেকে বর্তমান ব্যবহারকারীর সেশন আনুন
    let userSession = await sessionService.getSession(psid) || {};

    // ধাপ ১.২: AI ব্যবহার করে ইন্টেন্ট এবং এনটিটি সনাক্ত করুন
    const { intent, entities, confidence } = await aiService.getIntentAndEntities(incomingMessageText);
    console.log(`[AI Intent] Intent: ${intent}, Entities: ${JSON.stringify(entities)}, Confidence: ${confidence}`);

    // ব্যবহারকারীর মেসেজটি ব্যাকগ্রাউন্ডে সেভ করুন (অপেক্ষা করার দরকার নেই)
    if (type === 'message') {
        ChatLog.create({ pageId, psid, sender: 'user', message: { text: message.text } })
            .then(savedMessage => broadcastToPage(pageId, savedMessage))
            .catch(err => console.error('Error saving chat log:', err));
    }

    let replyText = ''; // replyText-কে একটি স্ট্রিং অথবা অবজেক্ট হিসেবে ব্যবহার করব
    let quickRepliesToAppend = null;

    // ধাপ ১.৪: Quick Replies (Keyword Auto-Response) চেক করুন
    if (!userSession.state) { // অর্ডার ফ্লোতে থাকলে কুইক রিপ্লাই কাজ করবে না
        const quickReplies = await QuickReply.find({ userId: page.ownerId });
        const matchedQuickReply = quickReplies.find(
            qr => qr.title.toLowerCase() === incomingMessageText
        );

        if (matchedQuickReply) {
            console.log(`[Quick Reply Match] Keyword matched: "${matchedQuickReply.title}"`);
            await facebookService.sendTextMessage(psid, matchedQuickReply.text, pageAccessToken);
            // বটের উত্তর সেভ করুন
            const botMessage = await ChatLog.create({ pageId, psid, sender: 'bot', message: { text: matchedQuickReply.text } });
            broadcastToPage(pageId, botMessage);
            return true; // কাজ শেষ
        }
    }

    // ধাপ ১.৫: যেকোনো পর্যায়ে অর্ডার বাতিল করার সুযোগ বা গ্লোবাল কমান্ড
    const isGlobalCommand = incomingMessageText.toLowerCase() === 'cancel' || 
                            incomingMessageText.toLowerCase() === 'products' || 
                            intent === 'show_products';
                            
    if (userSession.state && isGlobalCommand) {
        await sessionService.deleteSession(psid);
        userSession = {}; // বর্তমান রিকোয়েস্টের জন্য সেশন ক্লিয়ার করুন
        
        if (incomingMessageText.toLowerCase() === 'cancel') {
            replyText = 'আপনার অর্ডার প্রক্রিয়াটি বাতিল করা হয়েছে। নতুন করে শুরু করতে "products" লিখে পাঠান।';
            await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
            return true; // সফলভাবে প্রসেসড
        }
    }

    // ধাপ ২: নিয়ম-ভিত্তিক রাউটিং এর জন্য একটি রাউটার তৈরি করুন
    const messageRouter = [
        // অর্ডার ফ্লো
        { // ইন্টেন্ট: start_order অথবা BUY_ পোস্টব্যাক
            condition: () => incomingMessageText.startsWith('buy_'),
            action: async () => {
                const productId = incomingMessageText.split('_')[1];
                
                // চেক করুন ইউজার আগে অর্ডার করেছে কিনা
                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                if (customer && customer.phone && customer.address) {
                    userSession.state = 'confirm_existing_order';
                    userSession.order = { 
                        productId: productId, 
                        customerName: customer.name, 
                        phone: customer.phone, 
                        address: customer.address 
                    };
                    await sessionService.setSession(psid, userSession);
                    
                    const confirmText = `আমরা আপনার পূর্বের ঠিকানা খুঁজে পেয়েছি:\n\nনাম: ${customer.name}\nফোন: ${customer.phone}\nঠিকানা: ${customer.address}\n\nএই ঠিকানাতেই কি অর্ডারটি কনফার্ম করব?`;
                    const buttons = [
                        { type: 'postback', title: 'হ্যাঁ, কনফার্ম করুন', payload: `CONFIRM_ORDER` },
                        { type: 'postback', title: 'না, নতুন ঠিকানা দেব', payload: `NEW_ADDRESS` },
                        { type: 'postback', title: '❌ বাতিল করুন', payload: `CANCEL` }
                    ];
                    await facebookService.sendButtonTemplate(psid, confirmText, buttons, pageAccessToken);
                    return null; // টেমপ্লেট পাঠানো হয়েছে
                }

                userSession.state = 'awaiting_name';
                userSession.order = { productId: productId };
                await sessionService.setSession(psid, userSession);
                quickRepliesToAppend = [{ content_type: 'text', title: '❌ অর্ডার বাতিল করুন / ব্যাকে যান', payload: 'CANCEL' }];
                return 'এই পণ্যটি অর্ডার করতে, অনুগ্রহ করে আপনার সম্পূর্ণ নাম লিখুন।';
            }
        },
        { // Existing Order Confirmation
            condition: () => userSession.state === 'confirm_existing_order' || incomingMessageText === 'confirm_order' || incomingMessageText === 'new_address',
            action: async () => {
                if (incomingMessageText === 'new_address') {
                    userSession.state = 'awaiting_name';
                    await sessionService.setSession(psid, userSession);
                    quickRepliesToAppend = [{ content_type: 'text', title: '❌ অর্ডার বাতিল করুন / ব্যাকে যান', payload: 'CANCEL' }];
                    return 'ঠিক আছে, অনুগ্রহ করে আপনার সম্পূর্ণ নাম লিখুন।';
                }
                
                if (incomingMessageText !== 'confirm_order' && userSession.state === 'confirm_existing_order') {
                    const confirmText = `অনুগ্রহ করে নিচের বাটনগুলো থেকে একটি নির্বাচন করুন:\n\nএই ঠিকানাতেই কি অর্ডারটি কনফার্ম করব?`;
                    const buttons = [
                        { type: 'postback', title: 'হ্যাঁ, কনফার্ম করুন', payload: `CONFIRM_ORDER` },
                        { type: 'postback', title: 'না, নতুন ঠিকানা দেব', payload: `NEW_ADDRESS` },
                        { type: 'postback', title: '❌ বাতিল করুন', payload: `CANCEL` }
                    ];
                    await facebookService.sendButtonTemplate(psid, confirmText, buttons, pageAccessToken);
                    return null;
                }
                
                // Confirm Order
                const product = await Product.findById(userSession.order.productId);
                if (!product) {
                    await sessionService.deleteSession(psid);
                    return 'দুঃখিত, এই পণ্যটি আর উপলব্ধ নেই।';
                }
                const newOrder = new Order({
                    pageId: pageId, customerId: (await Customer.findOne({ psid: psid, pageId: pageId }))._id,
                    products: [{ productId: product._id, quantity: 1, price: product.price }],
                    totalAmount: product.price, status: 'pending',
                    shippingAddress: userSession.order.address,
                    customerInfo: { name: userSession.order.customerName, phone: userSession.order.phone },
                });
                await newOrder.save();
                await sessionService.deleteSession(psid);
                return `আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে! অর্ডার আইডি: ${newOrder._id}। আমাদের একজন প্রতিনিধি শীঘ্রই আপনার সাথে যোগাযোগ করবে।`;
            }
        },
        { // ইন্টেন্ট: provide_contact_info (নাম)
            condition: () => userSession.state === 'awaiting_name',
            action: async () => {
                if (intent === 'general_question' || (intent !== 'provide_contact_info' && incomingMessageText.split(' ').length > 3)) {
                    return ''; // Let AI handle this interruption
                }
                // যদি এনটিটি থেকে নাম পাওয়া যায়, সেটি ব্যবহার করুন
                userSession.order.customerName = entities.customerName || incomingMessageText;
                userSession.state = 'awaiting_phone';
                await sessionService.setSession(psid, userSession);

                // যদি একই বার্তায় ফোন নম্বরও থাকে, তাহলে পরবর্তী ধাপে যান
                if (entities.phone) {
                    return await processNextState(psid, userSession, entities.phone, pageAccessToken);
                }
                quickRepliesToAppend = [{ content_type: 'text', title: '❌ অর্ডার বাতিল করুন / ব্যাকে যান', payload: 'CANCEL' }];
                return 'ধন্যবাদ! এখন আপনার ফোন নম্বরটি দিন (যেমন: 01xxxxxxxxx)।';
            }
        },
        { // ইন্টেন্ট: provide_contact_info (ফোন)
            condition: () => userSession.state === 'awaiting_phone',
            action: async () => {
                if (intent === 'general_question') return ''; // AI handles interruption

                const phoneToValidate = entities.phone || incomingMessageText;
                const phoneRegex = /^(?:\+88|88)?(01[3-9]\d{8})$/;
                const match = phoneToValidate.match(phoneRegex);
                if (match) {
                    const formattedPhone = `+88${match[1]}`;
                    userSession.order.phone = formattedPhone;
                    userSession.state = 'awaiting_address';
                    await sessionService.setSession(psid, userSession);

                    // যদি একই বার্তায় ঠিকানাও থাকে, তাহলে পরবর্তী ধাপে যান
                    if (entities.address) {
                        return await processNextState(psid, userSession, entities.address, pageAccessToken);
                    }
                    quickRepliesToAppend = [{ content_type: 'text', title: '❌ অর্ডার বাতিল করুন / ব্যাকে যান', payload: 'CANCEL' }];
                    return 'খুব ভালো! সবশেষে, আপনার সম্পূর্ণ ডেলিভারি ঠিকানাটি লিখুন।';
                } else {
                    quickRepliesToAppend = [{ content_type: 'text', title: '❌ অর্ডার বাতিল করুন / ব্যাকে যান', payload: 'CANCEL' }];
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
            condition: () => intent === 'cancel_order' || incomingMessageText.startsWith('cancel_order_') || incomingMessageText === 'cancel',
            action: async () => {
                // If it's just 'cancel' from quick reply
                if (incomingMessageText === 'cancel') {
                    if(userSession.state) {
                        await sessionService.deleteSession(psid);
                        return 'আপনার অর্ডার প্রক্রিয়াটি বাতিল করা হয়েছে। নতুন করে শুরু করতে "products" লিখে পাঠান।';
                    }
                    return 'আপনার কোনো চলমান অর্ডার প্রক্রিয়া নেই।';
                }
                
                let orderId = null;
                if (incomingMessageText.startsWith('cancel_order_')) {
                    orderId = incomingMessageText.replace('cancel_order_', '');
                } else if (incomingMessageText.startsWith('cancel_')) {
                    orderId = incomingMessageText.replace('cancel_', '');
                }

                if (!orderId) {
                    const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                    if (customer) {
                        const latestOrder = await Order.findOne({ customerId: customer._id, status: 'pending' }).sort({ createdAt: -1 });
                        if (latestOrder) orderId = latestOrder._id;
                    }
                }

                if (!orderId) {
                    return 'আপনার বাতিল করার মতো কোনো পেন্ডিং অর্ডার পাওয়া যায়নি।';
                }

                const order = await Order.findById(orderId);
                if (order && order.status === 'pending') {
                    order.status = 'cancelled';
                    await order.save();
                    return `আপনার অর্ডার (ID: ${orderId}) সফলভাবে বাতিল করা হয়েছে।`;
                } else {
                    return `দুঃখিত, এই অর্ডারটি আর বাতিল করা সম্ভব নয়। শুধুমাত্র পেন্ডিং অর্ডার বাতিল করা যায়।`;
                }
            }
        },
        {
            condition: () => intent === 'track_order',
            action: async () => {
                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                if (!customer) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি। নতুন অর্ডার করতে "products" লিখে পাঠান।';
                const recentOrders = await Order.find({ customerId: customer._id }).sort({ createdAt: -1 }).limit(3);
                if (recentOrders.length === 0) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি।';

                let orderInfoText = `আপনার সাম্প্রতিক অর্ডারের তথ্য নিচে দেওয়া হলো:\n\n`;
                recentOrders.forEach((order, index) => {
                    orderInfoText += `${index + 1}. অর্ডার আইডি: ${order._id}\n   পরিমাণ: ${order.totalAmount} BDT, স্ট্যাটাস: ${order.status}\n`;
                });

                const latestOrder = recentOrders[0];
                if (latestOrder.status === 'pending') {
                    const buttons = [{ type: 'postback', title: 'Cancel Order', payload: `CANCEL_ORDER_${latestOrder._id}` }];
                    await facebookService.sendButtonTemplate(psid, orderInfoText, buttons, pageAccessToken);
                    return null;
                }
                return orderInfoText;
            }
        },
        {
            condition: () => incomingMessageText === 'talk_to_agent',
            action: async () => {
                return 'ধন্যবাদ! আপনার মেসেজটি আমাদের সাপোর্ট টিমের কাছে ফরোয়ার্ড করা হয়েছে। খুব শীঘ্রই একজন লাইভ এজেন্ট আপনার সাথে যুক্ত হবেন। অনুগ্রহ করে অপেক্ষা করুন।';
            }
        },
        {
            condition: () => incomingMessageText === 'delivery_charge',
            action: async () => {
                return 'আমাদের ডেলিভারি চার্জ:\nঢাকার ভেতরে: ৬০ টাকা\nঢাকার বাইরে: ১২০ টাকা।\n\nআপনি কি কোনো প্রোডাক্ট অর্ডার করতে চান?';
            }
        },
        {
            condition: () => intent === 'show_products' || incomingMessageText === 'show_collection',
            action: async () => {
                let products = await Product.find({ pageId }).limit(20);
                
                // If user asked for a specific product, use AI to filter the list
                if (entities && (entities.productName || entities.search_query)) {
                    const searchKeywords = entities.productName || entities.search_query;
                    const matchedProducts = await aiService.findBestMatchingProducts(searchKeywords, products);
                    if (matchedProducts && matchedProducts.length > 0) {
                        products = matchedProducts; // Only show matching products
                    }
                }
                
                products = products.slice(0, 10); // FB limits generic templates to 10 items

                if (products && products.length > 0) {
                    const elements = products.map(p => ({
                        title: p.name, subtitle: `Price: ${p.price} BDT\nStock: ${p.stock}`, image_url: getPublicImageUrl(p.imageUrl),
                        buttons: [
                            { type: 'postback', title: '🛒 অর্ডার করুন / কিনুন', payload: `BUY_${p._id}` },
                            { type: 'web_url', url: `https://your-website.com/product/${p._id}`, title: '📝 বিস্তারিত দেখুন' }
                        ],
                    }));
                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                    return null; // টেমপ্লেট পাঠানো হয়েছে
                }
                return 'দুঃখিত, এই মুহূর্তে আপনার কাঙ্ক্ষিত পণ্যটি পাওয়া যাচ্ছে না।';
            }
        },
    ];

    // একটি helper ফাংশন যা অর্ডার ফ্লোতে পরবর্তী ধাপে যেতে সাহায্য করবে
    const processNextState = async (psid, session, data, token) => {
        const newJobData = { ...jobData, message: { text: data }, postback: null };
        await processMessage(newJobData);
        return null;
    };

    for (const rule of messageRouter) {
        if (rule.condition()) {
            replyText = await rule.action();
            break; // প্রথম ম্যাচ করা রুলেই থেমে যান
        }
    }

    // ধাপ ৩: AI-ভিত্তিক ফলব্যাক
    // যদি কোনো নিয়ম না মেলে বা নিয়ম থেকে খালি স্ট্রিং ('') রিটার্ন হয়
    if (replyText === '') {
        // AI Limit and Date Check
        const currentDate = new Date();
        const aiResponseLimit = user?.subscriptionPlan?.aiResponseLimit || 0;
        const aiResponsesUsed = user?.subscriptionPlan?.aiResponsesUsed || 0;
        const startDate = user?.subscriptionPlan?.startDate ? new Date(user.subscriptionPlan.startDate) : null;
        const endDate = user?.subscriptionPlan?.endDate ? new Date(user.subscriptionPlan.endDate) : null;

        // Date check: true if no dates set (allow all), or if within range
        let isDateValid = true;
        if (startDate && endDate) {
            isDateValid = currentDate >= startDate && currentDate <= endDate;
        }
        
        const isLimitValid = aiResponsesUsed < aiResponseLimit;

        if (!isDateValid || !isLimitValid) {
            console.log(`User ${user._id} exceeded AI limit (${aiResponsesUsed}/${aiResponseLimit}) or subscription expired. Bot is silent.`);
            return true;
        }

        const queryForAI = incomingMessageText;
        console.log(`Forwarding to AI with query: "${queryForAI}"`);

        // কথোপকথনের ইতিহাস তৈরি করুন
        // ডেটাবেস থেকে একই সাথে হিস্ট্রি, প্রোডাক্ট এবং কাস্টমারের অর্ডার কল করুন
        const customer = await Customer.findOne({ psid: psid, pageId: pageId });
        const [recentMessages, products, customerOrders] = await Promise.all([
            ChatLog.find({ pageId, psid }).sort({ timestamp: -1 }).limit(4), // Reduced from 10 to 4 to save tokens
            Product.find({ pageId }).limit(5), // Reduced from 20 to 5 to save tokens
            customer ? Order.find({ customerId: customer._id }).sort({ createdAt: -1 }).limit(5) : Promise.resolve([])
        ]);
        const history = recentMessages.reverse().map(log => ({
            role: log.sender === 'user' ? 'user' : 'assistant',
            content: log.message?.text || '(Attachment or unknown message)',
        }));

        let productContext = "";
        if (products && products.length > 0) {
            productContext = "\n\n--- আপনার দোকানের বর্তমান প্রোডাক্ট তালিকা ---\n";
            products.forEach(p => {
                productContext += `- ${p.name} (দাম: ${p.price} BDT)\n`;
            });
            productContext += "\nগুরুত্বপূর্ণ নির্দেশনা: কাস্টমার যদি নির্দিষ্ট কোনো প্রোডাক্টের দাম জানতে চায় (যেমন 'এটার দাম কত?'), তবে চ্যাট হিস্ট্রি চেক করে শুধু সেই প্রোডাক্টেরই দাম দেবে। অযথা সব প্রোডাক্টের লিস্ট পাঠাবে না। বিস্তারিত ছবির জন্য কাস্টমারকে 'products' টাইপ করতে বলবে।";
        }

        let orderContext = "";
        if (customerOrders && customerOrders.length > 0) {
            orderContext = "\n\n--- এই কাস্টমারের সাম্প্রতিক অর্ডারের তথ্য ---\n";
            customerOrders.forEach(o => {
                orderContext += `- Order ID: ${o._id}, Status: ${o.status}, Total: ${o.totalAmount} BDT\n`;
            });
            
            // Calculate total pending amount
            const allPendingOrders = await Order.find({ customerId: customer._id, status: 'pending' });
            if (allPendingOrders.length > 0) {
                const totalPendingAmount = allPendingOrders.reduce((sum, o) => sum + o.totalAmount, 0);
                orderContext += `\n(নোট: কাস্টমারের মোট ${allPendingOrders.length} টি পেন্ডিং (pending) অর্ডার রয়েছে, যার সর্বমোট পরিমাণ ${totalPendingAmount} BDT)\n`;
            }

            orderContext += "\nগুরুত্বপূর্ণ নির্দেশনা: কাস্টমার যদি তার মোট বাকী বা পেন্ডিং অর্ডারের হিসাব জানতে চায়, তবে উপরের নোট থেকে সর্বমোট পরিমাণটি (Total Pending Amount) জানাবে।";
        }

        // কাস্টম বা ডিফল্ট প্রম্পট ব্যবহার
        let systemPromptText = page.aiSystemPrompt || "You are a helpful assistant.";
        if (page.useDefaultPrompt) {
            const defaultPromptSetting = await SystemSetting.findOne({ key: 'DEFAULT_AI_PROMPT' });
            if (defaultPromptSetting && defaultPromptSetting.value) {
                systemPromptText = defaultPromptSetting.value;
            }
        }

        systemPromptText = systemPromptText.replace(/\[আপনার পেজের নাম\]/g, page.name);
        systemPromptText = systemPromptText.replace(/\[Business_Name\]/gi, page.name);
        systemPromptText = systemPromptText.replace(/\[Agent_Name\]/gi, "[Your Name]");

        const finalPrompt = `${systemPromptText}

--- 
System Context:
- You are operating on the Facebook page "${page.name}".
- Your primary language for responses should be Bengali (বাংলা) unless requested otherwise.
- About the Business & Your Persona: ${page.businessType || 'You are representing ' + page.name}
- CRITICAL INSTRUCTION: Read the "About the Business & Your Persona" section carefully. If it gives you a specific name, you MUST introduce yourself with THAT name. If no specific name is mentioned, use "ডিজিটাল অ্যাসিস্ট্যান্ট" as your name. You MUST strictly adopt the business details and identity defined there.
${productContext}${orderContext}`;

        replyText = await aiService.getAIResponse(finalPrompt, [...history, { role: 'user', content: queryForAI }]);
        console.log(`[AI Response String] ${replyText}`);

        // Increment AI Usage count (Atomic update)
        if (user) {
            const updatedUser = await User.findByIdAndUpdate(
                user._id, 
                { $inc: { 'subscriptionPlan.aiResponsesUsed': 1 } },
                { new: true }
            );
            console.log(`[AI Limit] Usage updated for user ${user._id}: ${updatedUser.subscriptionPlan.aiResponsesUsed} / ${updatedUser.subscriptionPlan.aiResponseLimit}`);
        }
    }

    // ধাপ ৪: ব্যবহারকারীকে উত্তর পাঠান
    if (replyText) {
        // যদি AI এর উত্তর হয় এবং কোনো অর্ডার ফ্লোতে না থাকে, তাহলে ওয়েলকাম কুইক রিপ্লাই দিন
        if (!userSession.state && !quickRepliesToAppend) {
            quickRepliesToAppend = [
                { content_type: 'text', title: '🛍️ প্রোডাক্ট কালেকশন', payload: 'SHOW_COLLECTION' },
                { content_type: 'text', title: '📦 ডেলিভারি ও চার্জ', payload: 'DELIVERY_CHARGE' },
                { content_type: 'text', title: '📞 এজেন্টের সাথে কথা বলুন', payload: 'TALK_TO_AGENT' }
            ];
        }

        if (quickRepliesToAppend && quickRepliesToAppend.length > 0) {
            await facebookService.sendTextMessageWithQuickReplies(psid, replyText, quickRepliesToAppend, pageAccessToken);
        } else {
            await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
        }
        
        // বটের উত্তর চ্যাট লগে সংরক্ষণ করুন
        const botMessage = await ChatLog.create({ pageId, psid, sender: 'bot', message: { text: replyText } });
        // বটের উত্তর ব্রডকাস্ট করুন
        broadcastToPage(pageId, botMessage);
        return true; // সফলভাবে প্রসেসড
    }

    // যদি কোনো উত্তর তৈরি না হয়, তাহলে একটি লগ প্রিন্ট করুন
    console.log(`[Processor] No reply generated for message: "${incomingMessageText}". Current session state: ${userSession.state || 'none'}.`);
    // কোনো উত্তর পাঠানো হয়নি, তাই জবটি সফল হিসেবে গণ্য হবে না এবং পুনরায় চেষ্টা করা হতে পারে।
    // এটিকে true করলে জবটি সফল হিসেবে গণ্য হবে এবং পুনরায় চেষ্টা করা হবে না।
    return true; // কোনো উত্তর না থাকলেও জবটিকে সফল হিসেবে চিহ্নিত করুন, যাতে এটি বারবার রান না করে।
};

module.exports = { processMessage };