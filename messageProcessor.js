const Page = require('./Page');
const ChatLog = require('./ChatLog');
const Product = require('./Product');
const Order = require('./Order');
const Customer = require('./Customer');
const facebookService = require('./facebookService'); // This should be './facebookService'
const { broadcastToPage } = require('./websocket');
const aiService = require('./aiService');
const sessionService = require('./sessionService');

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
                // যদি এনটিটি থেকে নাম পাওয়া যায়, সেটি ব্যবহার করুন
                userSession.order.customerName = entities.customerName || incomingMessageText;
                userSession.state = 'awaiting_phone';
                await sessionService.setSession(psid, userSession);

                // যদি একই মেসেজে ফোন নম্বরও পাওয়া যায়, তাহলে ফোন নম্বরের স্টেপটি স্কিপ করে ঠিকানার জন্য প্রম্পট করুন
                // যদি একই বার্তায় ফোন নম্বরও থাকে, তাহলে পরবর্তী ধাপে যান
                // এই helper ফাংশনটি বর্তমানে সংজ্ঞায়িত নয়, তাই এটি একটি উন্নত করার সুযোগ
                // if (entities.phone) { return await processNextState(psid, userSession, entities.phone, pageAccessToken); }
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

                    // যদি একই মেসেজে ঠিকানাও পাওয়া যায়, তাহলে ঠিকানার স্টেপটি স্কিপ করে অর্ডার কনফার্ম করুন
                    // যদি একই বার্তায় ঠিকানাও থাকে, তাহলে পরবর্তী ধাপে যান
                    // এই helper ফাংশনটি বর্তমানে সংজ্ঞায়িত নয়, তাই এটি একটি উন্নত করার সুযোগ
                    // if (entities.address) { return await processNextState(psid, userSession, entities.address, pageAccessToken); }
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
                const customer = await Customer.findOne({ psid: psid, pageId: pageIdconst Page = require('./Page');
                const ChatLog = require('./ChatLog');
                const Product = require('./Product');
                const Order = require('./Order');
                const Customer = require('./Customer');
                const facebookService = require('./facebookService'); // This should be './facebookService'
                const { broadcastToPage } = require('./websocket');
                const aiService = require('./aiService');
                const sessionService = require('./sessionService');
                
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
                            console.log(`[Visual Search] Received image from user . URL: ${attachment.payload.url}`);
                            
                            // ১. ছবি থেকে সার্চের জন্য বর্ণনা তৈরি করুন
                            const searchKeywords = await aiService.getImageDescriptionForSearch(attachment.payload.url);
                            console.log(`[Visual Search] Keywords from AI: ""`);
                
                            if (searchKeywords) {
                                // ২. ডাটাবেসে Atlas Search ব্যবহার করে সার্চ করুন
                                const matchedProducts = await Product.aggregate([
                                    {
                                        : {
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
                                        : { pageId: pageId } // সার্চ ফলাফলের পর পেজ আইডি দিয়ে ফিল্টার করুন
                                    },
                                    { : 5 }, // ফলাফলের সংখ্যা ৫-এর মধ্যে সীমাবদ্ধ রাখুন
                                    { : { score: { : "searchScore" } } } // প্রাসঙ্গিকতা স্কোর যোগ করুন (ঐচ্ছিক)
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
                        console.log(`Human takeover is active for page . Bot is silent.`);
                        return true; // সফলভাবে প্রসেসড, কিন্তু কোনো উত্তর নেই
                    }
                
                    // ধাপ ১.২: AI ব্যবহার করে ইন্টেন্ট এবং এনটিটি সনাক্ত করুন
                    const { intent, entities, confidence } = await aiService.getIntentAndEntities(incomingMessageText);
                    console.log(`[AI Intent] Intent: , Entities: ${JSON.stringify(entities)}, Confidence: `);
                
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
                                // যদি এনটিটি থেকে নাম পাওয়া যায়, সেটি ব্যবহার করুন
                                userSession.order.customerName = entities.customerName || incomingMessageText;
                                userSession.state = 'awaiting_phone';
                                await sessionService.setSession(psid, userSession);
                
                                // যদি একই বার্তায় ফোন নম্বরও থাকে, তাহলে পরবর্তী ধাপে যান
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
                
                                    // যদি একই বার্তায় ঠিকানাও থাকে, তাহলে পরবর্তী ধাপে যান
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
                                    return `আপনার অর্ডার (ID: ) সফলভাবে বাতিল করা হয়েছে।`;
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
                            condition: () => intent === 'show_products',
                            action: async () => {
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
                
                    // একটি helper ফাংশন যা অর্ডার ফ্লোতে পরবর্তী ধাপে যেতে সাহায্য করবে
                    const processNextState = async (psid, session, data, token) => {
                        const processor = new MessageProcessor(jobData); // একটি কাল্পনিক ক্লাস যা processMessage লজিক ধারণ করে
                        return await processor.processMessageWithIntent(data); // একটি কাল্পনিক মেথড
                    };
                
                    for (const rule of messageRouter) {
                        if (rule.condition()) {
                            replyText = await rule.action();
                            break; // প্রথম ম্যাচ করা রুলেই থেমে যান
                        }
                    }
                
                    // ধাপ ৩: AI-ভিত্তিক ফলব্যাক
                    // যদি কোনো নিয়ম না মেলে এবং কোনো সেশন স্টেট না থাকে, অথবা ইন্টেন্ট যদি 'general_question' হয়
                    if ((replyText === '' && !userSession.state) || intent === 'general_question') {
                        const queryForAI = incomingMessageText;
                        console.log(`Forwarding to AI with query: ""`);
                
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
                
                        const finalPrompt = systemPromptText + productContext;
                
                        replyText = await aiService.getAIResponse(finalPrompt, [...history, { role: 'user', content: queryForAI }]);
                    }
                
                    // ধাপ ৪: ব্যবহারকারীকে উত্তর পাঠান
                    // "Please respond..." বার্তাটি ব্যবহারকারীকে পাঠানো হবে না
                    if (replyText) {
                        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
                        // বটের উত্তর চ্যাট লগে সংরক্ষণ করুন
                        const botMessage = await ChatLog.create({ pageId, psid, sender: 'bot', message: { text: replyText } });
                        // বটের উত্তর ব্রডকাস্ট করুন
                        broadcastToPage(pageId, botMessage);
                        return true; // সফলভাবে প্রসেসড
                    }
                
                    // যদি কোনো উত্তর তৈরি না হয়, তাহলে একটি লগ প্রিন্ট করুন
                    console.log(`[Processor] No reply generated for message: "". Current session state: ${userSession.state || 'none'}.`);
                    // কোনো উত্তর পাঠানো হয়নি, তাই জবটি সফল হিসেবে গণ্য হবে না এবং পুনরায় চেষ্টা করা হতে পারে।
                    // এটিকে true করলে জবটি সফল হিসেবে গণ্য হবে এবং পুনরায় চেষ্টা করা হবে না।
                    return true; // কোনো উত্তর না থাকলেও জবটিকে সফল হিসেবে চিহ্নিত করুন, যাতে এটি বারবার রান না করে।
                };
                
                module.exports = { processMessage };{
                  "mappings": {
                    "dynamic": false,
                    "fields": {
                      "description": {
                        "type": "string"
                      },
                      "name": {
                        "type": "string"
                      }
                    }
                  }
                }
                --- a/d:/allproject/facebookbot/chatbot/messageProcessor.js
                +++ b/d:/allproject/facebookbot/chatbot/messageProcessor.js
                @@ -232,185 +232,7 @@
                         {
                             condition: () => intent === 'track_order',
                             action: async () => {
                -                const customer = await Customer.findOne({ psid: psid, pageId: pageIdconst Page = require('./Page');
                -                const ChatLog = require('./ChatLog');
                -                const Product = require('./Product');
                -                const Order = require('./Order');
                -                const Customer = require('./Customer');
                -                const facebookService = require('./facebookService'); // This should be './facebookService'
                -                const { broadcastToPage } = require('./websocket');
                -                const aiService = require('./aiService');
                -                const sessionService = require('./sessionService');
                -                
                -                const processMessage = async (jobData) => {
                -                    const { type, pageId, psid, message, postback } = jobData;
                -                
                -                    // ধাপ ১: পেজের তথ্য এবং অ্যাক্সেস টোকেন আনুন
                -                    const page = await Page.findOne({ pageId }).select('+pageAccessToken +humanTakeover +aiSystemPrompt');
                -                    if (!page) {
                -                        console.error(`Page with ID ${pageId} not found.`);
                -                        return false; // প্রসেসিং ব্যর্থ
                -                    }
                -                    const pageAccessToken = facebookService.decryptToken(page.pageAccessToken);
                -                
                -                    // ধাপ ১.১: অ্যাটাচমেন্ট (ছবি) হ্যান্ডেল করুন
                -                    if (type === 'message' && message.attachments && message.attachments.length > 0) {
                -                        const attachment = message.attachments[0];
                -                        if (attachment.type === 'image' && !page.humanTakeover) {
                -                            console.log(`[Visual Search] Received image from user . URL: ${attachment.payload.url}`);
                -                            
                -                            // ১. ছবি থেকে সার্চের জন্য বর্ণনা তৈরি করুন
                -                            const searchKeywords = await aiService.getImageDescriptionForSearch(attachment.payload.url);
                -                            console.log(`[Visual Search] Keywords from AI: ""`);
                -                
                -                            if (searchKeywords) {
                -                                // ২. ডাটাবেসে Atlas Search ব্যবহার করে সার্চ করুন
                -                                const matchedProducts = await Product.aggregate([
                -                                    {
                -                                        : {
                -                                            index: 'product_search', // Atlas UI-তে তৈরি করা ইনডেক্সের নাম
                -                                            text: {
                -                                                query: searchKeywords,
                -                                                path: ['name', 'description'], // যে ফিল্ডগুলোতে সার্চ করতে হবে
                -                                                fuzzy: { // টাইপো বা ছোটখাটো ভুল বানান ঠিক করার জন্য
                -                                                    maxEdits: 1,
                -                                                    prefixLength: 2
                -                                                }
                -                                            }
                -                                        }
                -                                    },
                -                                    {
                -                                        : { pageId: pageId } // সার্চ ফলাফলের পর পেজ আইডি দিয়ে ফিল্টার করুন
                -                                    },
                -                                    { : 5 }, // ফলাফলের সংখ্যা ৫-এর মধ্যে সীমাবদ্ধ রাখুন
                -                                    { : { score: { : "searchScore" } } } // প্রাসঙ্গিকতা স্কোর যোগ করুন (ঐচ্ছিক)
                -                                ]);
                -                
                -                                if (matchedProducts.length > 0) {
                -                                    // ৩. ম্যাচ পাওয়া গেলে
                -                                    await facebookService.sendTextMessage(psid, "আপনার পাঠানো ছবির সাথে মিলে যাওয়া কিছু পণ্য নিচে দেওয়া হলো:", pageAccessToken);
                -                                    const elements = matchedProducts.map(p => ({
                -                                        title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: p.imageUrl,
                -                                        buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                -                                    }));
                -                                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                } else {
                -                                    // ৪. ম্যাচ না পাওয়া গেলে
                -                                    await facebookService.sendTextMessage(psid, "দুঃখিত, আপনার পাঠানো ছবির পণ্যটি আমাদের সংগ্রহে নেই। তবে, আমাদের অন্যান্য জনপ্রিয় কিছু পণ্য নিচে দেখুন:", pageAccessToken);
                -                                    const otherProducts = await Product.find({ pageId: pageId }).sort({ createdAt: -1 }).limit(5);
                -                                    if (otherProducts.length > 0) {
                -                                        const elements = otherProducts.map(p => ({
                -                                            title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: p.imageUrl,
                -                                            buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                -                                        }));
                -                                        await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                    }
                -                                }
                -                            }
                -                            return true; // ছবি প্রসেস করা শেষ
                -                        }
                -                    }
                -                
                -                    // পোস্টব্যাক বা মেসেজ থেকে টেক্সট নিন
                -                    const incomingMessageText = type === 'message' && message.text
                -                        ? message.text.toLowerCase().trim() 
                -                        : (postback && postback.payload ? postback.payload : '');
                -                
                -                    // Redis থেকে বর্তমান ব্যবহারকারীর সেশন আনুন
                -                    const userSession = await sessionService.getSession(psid) || {};
                -                
                -                    // যদি Human Takeover সক্রিয় থাকে, তাহলে বট কোনো উত্তর দেবে না
                -                    if (page.humanTakeover) {
                -                        console.log(`Human takeover is active for page . Bot is silent.`);
                -                        return true; // সফলভাবে প্রসেসড, কিন্তু কোনো উত্তর নেই
                -                    }
                -                
                -                    // ধাপ ১.২: AI ব্যবহার করে ইন্টেন্ট এবং এনটিটি সনাক্ত করুন
                -                    const { intent, entities, confidence } = await aiService.getIntentAndEntities(incomingMessageText);
                -                    console.log(`[AI Intent] Intent: , Entities: ${JSON.stringify(entities)}, Confidence: `);
                -                
                -                    // ব্যবহারকারীর মেসেজটি চ্যাট লগে সংরক্ষণ করুন
                -                    if (type === 'message') {
                -                        const savedMessage = await ChatLog.create({ pageId, psid, sender: 'user', message: { text: message.text } });
                -                        // নতুন মেসেজ ব্রডকাস্ট করুন
                -                        broadcastToPage(pageId, savedMessage);
                -                    }
                -                
                -                    let replyText = ''; // replyText-কে একটি খালি স্ট্রিং দিয়ে শুরু করুন
                -                
                -                    // ধাপ ১.৫: যেকোনো পর্যায়ে অর্ডার বাতিল করার সুযোগ
                -                    if (userSession.state && incomingMessageText === 'cancel') {
                -                        await sessionService.deleteSession(psid);
                -                        replyText = 'আপনার অর্ডার প্রক্রিয়াটি বাতিল করা হয়েছে। নতুন করে শুরু করতে "products" লিখে পাঠান।';
                -                        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
                -                        return true; // সফলভাবে প্রসেসড
                -                    }
                -                
                -                    // ধাপ ২: নিয়ম-ভিত্তিক রাউটিং এর জন্য একটি রাউটার তৈরি করুন
                -                    const messageRouter = [
                -                        // অর্ডার ফ্লো
                -                        { // ইন্টেন্ট: start_order অথবা BUY_ পোস্টব্যাক
                -                            condition: () => incomingMessageText.startsWith('BUY_'),
                -                            action: async () => {
                -                                const productId = incomingMessageText.split('_')[1];
                -                                userSession.state = 'awaiting_name';
                -                                userSession.order = { productId: productId };
                -                                await sessionService.setSession(psid, userSession);
                -                                return 'এই পণ্যটি অর্ডার করতে, অনুগ্রহ করে আপনার সম্পূর্ণ নাম লিখুন।';
                -                            }
                -                        },
                -                        { // ইন্টেন্ট: provide_contact_info (নাম)
                -                            condition: () => userSession.state === 'awaiting_name',
                -                            action: async () => {
                -                                // যদি এনটিটি থেকে নাম পাওয়া যায়, সেটি ব্যবহার করুন
                -                                userSession.order.customerName = entities.customerName || incomingMessageText;
                -                                userSession.state = 'awaiting_phone';
                -                                await sessionService.setSession(psid, userSession);
                -                
                -                                // যদি একই বার্তায় ফোন নম্বরও থাকে, তাহলে পরবর্তী ধাপে যান
                -                                if (entities.phone) {
                -                                    return await processNextState(psid, userSession, entities.phone, pageAccessToken);
                -                                }
                -                                return 'ধন্যবাদ! এখন আপনার ফোন নম্বরটি দিন (যেমন: 01xxxxxxxxx)।';
                -                            }
                -                        },
                -                        { // ইন্টেন্ট: provide_contact_info (ফোন)
                -                            condition: () => userSession.state === 'awaiting_phone',
                -                            action: async ()।';
                -                                }
                -                            }
                -                        },
                -                        {
                -                            // ইন্টেন্ট: provide_contact_info (ঠিকানা)
                -                            condition: () => userSession.state === 'awaiting_address',
                -                            action: async () => {
                -                                userSession.order.address = entities.address || incomingMessageText;
                -                                const product = await Product.findById(userSession.order.productId);
                -                                if (!product) {
                -                                    await sessionService.deleteSession(psid);
                -                                    return 'দুঃখিত, এই পণ্যটি আর উপলব্ধ নেই।';
                -                                }
                -                                const customer = await Customer.findOneAndUpdate(
                -                                    { psid: psid, pageId: pageId },
                -                                    { name: userSession.order.customerName, phone: userSession.order.phone, address: userSession.order.address },
                -                                    { upsert: true, new: true }
                -                                );
                -                                const newOrder = new Order({
                -                                    pageId: pageId, customerId: customer._id,
                -                                    products: [{ productId: product._id, quantity: 1, price: product.price }],
                -                                    totalAmount: product.price, status: 'pending',
                -                                    shippingAddress: userSession.order.address,
                -                                    customerInfo: { name: userSession.order.customerName, phone: userSession.order.phone },
                -                                });
                -                                await newOrder.save();
                -                                await sessionService.deleteSession(psid);
                -                                return `আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে! আপনার অর্ডার আইডি হলো: ${newOrder._id}। আমাদের একজন প্রতিনিধি শীঘ্রই আপনার সাথে যোগাযোগ করবে।`;
                -                            }
                -                        },
                -                        // অন্যান্য কীওয়ার্ড
                -                        {
                -                            condition: () => intent === 'cancel_order' || incomingMessageText.startsWith('CANCEL_ORDER_'),
                -                            action: async () => {
                -                                const orderId = incomingMessageText.split('_')[1];
                -                                const order = await Order.findById(orderId);
                -                                if (order && (order.status === 'pending' || order.status === 'confirmed')) {
                -                                    order.status = 'cancelled';
                -                                    await order.save();
                -                                    return `আপনার অর্ডার (ID: ) সফলভাবে বাতিল করা হয়েছে।`;
                -                                } else {
                -                                    return `দুঃখিত, এই অর্ডারটি আর বাতিল করা সম্ভব নয়।`;
                -                                }
                -                            }
                -                        },
                -                        {
                -                            condition: () => intent === 'track_order',
                -                            action: async () => {
                -                                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                -                                if (!customer) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি। নতুন অর্ডার করতে "products" লিখে পাঠান।';
                -                                
                -                                const latestOrder = await Order.findOne({ customerId: customer._id }).sort({ createdAt: -1 });
                -                                if (!latestOrder) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি।';
                -                
                -                                const orderInfoText = `আপনার সর্বশেষ অর্ডারের তথ্য নিচে দেওয়া হলো:\n\n` +
                -                                                    `অর্ডার আইডি: ${latestOrder._id}\n` +
                -                                                    `মোট পরিমাণ: ${latestOrder.totalAmount} BDT\n` +
                -                                                    `স্ট্যাটাস: ${latestOrder.status}`;
                -                
                -                                if (latestOrder.status === 'pending' || latestOrder.status === 'confirmed') {
                -                                    const buttons = [{ type: 'postback', title: 'Cancel Order', payload: `CANCEL_ORDER_${latestOrder._id}` }];
                -                                    await facebookService.sendButtonTemplate(psid, orderInfoText, buttons, pageAccessToken);
                -                                    return null; // যেহেতু একটি টেমপ্লেট পাঠানো হয়েছে, তাই কোনো টেক্সট রিপ্লাই নেই
                -                                }
                -                                return orderInfoText;
                -                            }
                -                        },
                -                        {
                -                            condition: () => intent === 'show_products',
                -                            action: async () => {
                -                                const products = await Product.find({ pageId }).limit(10);
                -                                if (products && products.length > 0) {
                -                                    const elements = products.map(p => ({
                -                                        title: p.name, subtitle: `Price: ${p.price} BDT\nStock: ${p.stock}`, image_url: p.imageUrl,
                -                                        buttons: [
                -                                            { type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` },
                -                                            { type: 'web_url', url: 'https://your-website.com/contact', title: 'Contact Us' },
                -                                        ],
                -                                    }));
                -                                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                    return null; // টেমপ্লেট পাঠানো হয়েছে
                -                                }
                -                                return 'দুঃখিত, এই মুহূর্তে দোকানে কোনো পণ্য উপলব্ধ নেই।';
                -                            }
                -                        },
                -                    ];
                -                
                -                    // একটি helper ফাংশন যা অর্ডার ফ্লোতে পরবর্তী ধাপে যেতে সাহায্য করবে
                -                    const processNextState = async (psid, session, data, token) => {
                -                        const processor = new MessageProcessor(jobData); // একটি কাল্পনিক ক্লাস যা processMessage লজিক ধারণ করে
                -                        return await processor.processMessageWithIntent(data); // একটি কাল্পনিক মেথড
                -                    };
                -                
                -                    for (const rule of messageRouter) {
                -                        if (rule.condition()) {
                -                            replyText = await rule.action();
                -                            break; // প্রথম ম্যাচ করা রুলেই থেমে যান
                -                        }
                -                    }
                -                
                -                    // ধাপ ৩: AI-ভিত্তিক ফলব্যাক
                -                    // যদি কোনো নিয়ম না মেলে এবং কোনো সেশন স্টেট না থাকে, অথবা ইন্টেন্ট যদি 'general_question' হয়
                -                    if ((replyText === '' && !userSession.state) || intent === 'general_question') {
                -                        const queryForAI = incomingMessageText;
                -                        console.log(`Forwarding to AI with query: ""`);
                -                
                -                        // কথোপকথনের ইতিহাস তৈরি করুন
                -                        const recentMessages = await ChatLog.find({ pageId, psid })
                -                            .sort({ timestamp: -1 })
                -                            .limit(10);
                -                        
                -                        const history = recentMessages.reverse().map(log => ({
                -                            role: log.sender === 'user' ? 'user' : 'assistant',
                -                            content: log.message?.text || '(Attachment or unknown message)',
                -                        }));
                -                
                -                        // ডাটাবেস থেকে প্রোডাক্টগুলো আনুন যাতে এআই জানে কী কী প্রোডাক্ট আছে
                -                        const products = await Product.find({ pageId }).limit(20);
                -                        let productContext = "";
                -                        if (products && products.length > 0) {
                -                            productContext = "\n\n--- আপনার দোকানের বর্তমান প্রোডাক্ট তালিকা ---\n";
                -                            products.forEach(p => {
                -                                productContext += `- ${p.name} (দাম: ${p.price} BDT, স্টক: ${p.stock})\n`;
                -                                if (p.description) productContext += `  বিবরণ: ${p.description}\n`;
                -                            });
                -                            productContext += "\nকাস্টমার যদি কোনো প্রোডাক্ট বা দাম সম্পর্কে জানতে চায়, উপরের তালিকা থেকে তথ্য দেবে। যদি বিস্তারিত ছবি দেখতে চায়, তবে কাস্টমারকে 'products' শব্দটি লিখে সেন্ড করতে বলবে, তাহলে সিস্টেম অটোমেটিক ছবিসহ প্রোডাক্ট পাঠাবে।";
                -                        }
                -                
                -                        // কাস্টম প্রম্পট থেকে [আপনার পেজের নাম] লেখাটি রিপ্লেস করে আসল পেজের নাম বসিয়ে দিন
                -                        let systemPromptText = page.aiSystemPrompt || "";
                -                        systemPromptText = systemPromptText.replace(/\[আপনার পেজের নাম\]/g, page.name);
                -                
                -                        const finalPrompt = systemPromptText + productContext;
                -                
                -                        replyText = await aiService.getAIResponse(finalPrompt, [...history, { role: 'user', content: queryForAI }]);
                -                    }
                -                
                -                    // ধাপ ৪: ব্যবহারকারীকে উত্তর পাঠান
                -                    // "Please respond..." বার্তাটি ব্যবহারকারীকে পাঠানো হবে না
                -                    if (replyText) {
                -                        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
                -                        // বটের উত্তর চ্যাট লগে সংরক্ষণ করুন
                -                        const botMessage = await ChatLog.create({ pageId, psid, sender: 'bot', message: { text: replyText } });
                -                        // বটের উত্তর ব্রডকাস্ট করুন
                -                        broadcastToPage(pageId, botMessage);
                -                        return true; // সফলভাবে প্রসেসড
                -                    }
                -                
                -                    // যদি কোনো উত্তর তৈরি না হয়, তাহলে একটি লগ প্রিন্ট করুন
                -                    console.log(`[Processor] No reply generated for message: "". Current session state: ${userSession.state || 'none'}.`);
                -                    // কোনো উত্তর পাঠানো হয়নি, তাই জবটি সফল হিসেবে গণ্য হবে না এবং পুনরায় চেষ্টা করা হতে পারে।
                -                    // এটিকে true করলে জবটি সফল হিসেবে গণ্য হবে এবং পুনরায় চেষ্টা করা হবে না।
                -                    return true; // কোনো উত্তর না থাকলেও জবটিকে সফল হিসেবে চিহ্নিত করুন, যাতে এটি বারবার রান না করে।
                -                };
                -                
                -                module.exports = { processMessage };{
                -                  "mappings": {
                -                    "dynamic": false,
                -                    "fields": {
                -                      "description": {
                -                        "type": "string"
                -                      },
                -                      "name": {
                -                        "type": "string"
                -                      }
                -                    }
                -                  }
                -                }
                -                 });
                +                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                                 if (!customer) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি। নতুন অর্ডার করতে "products" লিখে পাঠান।';
                                 
                                 const latestOrder = await Order.findOne({ customerId: customer._id }).sort({ createdAt: -1 });
                
                --- a/d:/allproject/facebookbot/chatbot/messageProcessor.js
                +++ b/d:/allproject/facebookbot/chatbot/messageProcessor.js
                @@ -232,185 +232,7 @@
                         {
                             condition: () => intent === 'track_order',
                             action: async () => {
                -                const customer = await Customer.findOne({ psid: psid, pageId: pageIdconst Page = require('./Page');
                -                const ChatLog = require('./ChatLog');
                -                const Product = require('./Product');
                -                const Order = require('./Order');
                -                const Customer = require('./Customer');
                -                const facebookService = require('./facebookService'); // This should be './facebookService'
                -                const { broadcastToPage } = require('./websocket');
                -                const aiService = require('./aiService');
                -                const sessionService = require('./sessionService');
                -                
                -                const processMessage = async (jobData) => {
                -                    const { type, pageId, psid, message, postback } = jobData;
                -                
                -                    // ধাপ ১: পেজের তথ্য এবং অ্যাক্সেস টোকেন আনুন
                -                    const page = await Page.findOne({ pageId }).select('+pageAccessToken +humanTakeover +aiSystemPrompt');
                -                    if (!page) {
                -                        console.error(`Page with ID ${pageId} not found.`);
                -                        return false; // প্রসেসিং ব্যর্থ
                -                    }
                -                    const pageAccessToken = facebookService.decryptToken(page.pageAccessToken);
                -                
                -                    // ধাপ ১.১: অ্যাটাচমেন্ট (ছবি) হ্যান্ডেল করুন
                -                    if (type === 'message' && message.attachments && message.attachments.length > 0) {
                -                        const attachment = message.attachments[0];
                -                        if (attachment.type === 'image' && !page.humanTakeover) {
                -                            console.log(`[Visual Search] Received image from user . URL: ${attachment.payload.url}`);
                -                            
                -                            // ১. ছবি থেকে সার্চের জন্য বর্ণনা তৈরি করুন
                -                            const searchKeywords = await aiService.getImageDescriptionForSearch(attachment.payload.url);
                -                            console.log(`[Visual Search] Keywords from AI: ""`);
                -                
                -                            if (searchKeywords) {
                -                                // ২. ডাটাবেসে Atlas Search ব্যবহার করে সার্চ করুন
                -                                const matchedProducts = await Product.aggregate([
                -                                    {
                -                                        : {
                -                                            index: 'product_search', // Atlas UI-তে তৈরি করা ইনডেক্সের নাম
                -                                            text: {
                -                                                query: searchKeywords,
                -                                                path: ['name', 'description'], // যে ফিল্ডগুলোতে সার্চ করতে হবে
                -                                                fuzzy: { // টাইপো বা ছোটখাটো ভুল বানান ঠিক করার জন্য
                -                                                    maxEdits: 1,
                -                                                    prefixLength: 2
                -                                                }
                -                                            }
                -                                        }
                -                                    },
                -                                    {
                -                                        : { pageId: pageId } // সার্চ ফলাফলের পর পেজ আইডি দিয়ে ফিল্টার করুন
                -                                    },
                -                                    { : 5 }, // ফলাফলের সংখ্যা ৫-এর মধ্যে সীমাবদ্ধ রাখুন
                -                                    { : { score: { : "searchScore" } } } // প্রাসঙ্গিকতা স্কোর যোগ করুন (ঐচ্ছিক)
                -                                ]);
                -                
                -                                if (matchedProducts.length > 0) {
                -                                    // ৩. ম্যাচ পাওয়া গেলে
                -                                    await facebookService.sendTextMessage(psid, "আপনার পাঠানো ছবির সাথে মিলে যাওয়া কিছু পণ্য নিচে দেওয়া হলো:", pageAccessToken);
                -                                    const elements = matchedProducts.map(p => ({
                -                                        title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: p.imageUrl,
                -                                        buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                -                                    }));
                -                                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                } else {
                -                                    // ৪. ম্যাচ না পাওয়া গেলে
                -                                    await facebookService.sendTextMessage(psid, "দুঃখিত, আপনার পাঠানো ছবির পণ্যটি আমাদের সংগ্রহে নেই। তবে, আমাদের অন্যান্য জনপ্রিয় কিছু পণ্য নিচে দেখুন:", pageAccessToken);
                -                                    const otherProducts = await Product.find({ pageId: pageId }).sort({ createdAt: -1 }).limit(5);
                -                                    if (otherProducts.length > 0) {
                -                                        const elements = otherProducts.map(p => ({
                -                                            title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: p.imageUrl,
                -                                            buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                -                                        }));
                -                                        await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                    }
                -                                }
                -                            }
                -                            return true; // ছবি প্রসেস করা শেষ
                -                        }
                -                    }
                -                
                -                    // পোস্টব্যাক বা মেসেজ থেকে টেক্সট নিন
                -                    const incomingMessageText = type === 'message' && message.text
                -                        ? message.text.toLowerCase().trim() 
                -                        : (postback && postback.payload ? postback.payload : '');
                -                
                -                    // Redis থেকে বর্তমান ব্যবহারকারীর সেশন আনুন
                -                    const userSession = await sessionService.getSession(psid) || {};
                -                
                -                    // যদি Human Takeover সক্রিয় থাকে, তাহলে বট কোনো উত্তর দেবে না
                -                    if (page.humanTakeover) {
                -                        console.log(`Human takeover is active for page . Bot is silent.`);
                -                        return true; // সফলভাবে প্রসেসড, কিন্তু কোনো উত্তর নেই
                -                    }
                -                
                -                    // ধাপ ১.২: AI ব্যবহার করে ইন্টেন্ট এবং এনটিটি সনাক্ত করুন
                -                    const { intent, entities, confidence } = await aiService.getIntentAndEntities(incomingMessageText);
                -                    console.log(`[AI Intent] Intent: , Entities: ${JSON.stringify(entities)}, Confidence: `);
                -                
                -                    // ব্যবহারকারীর মেসেজটি চ্যাট লগে সংরক্ষণ করুন
                -                    if (type === 'message') {
                -                        const savedMessage = await ChatLog.create({ pageId, psid, sender: 'user', message: { text: message.text } });
                -                        // নতুন মেসেজ ব্রডকাস্ট করুন
                -                        broadcastToPage(pageId, savedMessage);
                -                    }
                -                
                -                    let replyText = ''; // replyText-কে একটি খালি স্ট্রিং দিয়ে শুরু করুন
                -                
                -                    // ধাপ ১.৫: যেকোনো পর্যায়ে অর্ডার বাতিল করার সুযোগ
                -                    if (userSession.state && incomingMessageText === 'cancel') {
                -                        await sessionService.deleteSession(psid);
                -                        replyText = 'আপনার অর্ডার প্রক্রিয়াটি বাতিল করা হয়েছে। নতুন করে শুরু করতে "products" লিখে পাঠান।';
                -                        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
                -                        return true; // সফলভাবে প্রসেসড
                -                    }
                -                
                -                    // ধাপ ২: নিয়ম-ভিত্তিক রাউটিং এর জন্য একটি রাউটার তৈরি করুন
                -                    const messageRouter = [
                -                        // অর্ডার ফ্লো
                -                        { // ইন্টেন্ট: start_order অথবা BUY_ পোস্টব্যাক
                -                            condition: () => incomingMessageText.startsWith('BUY_'),
                -                            action: async () => {
                -                                const productId = incomingMessageText.split('_')[1];
                -                                userSession.state = 'awaiting_name';
                -                                userSession.order = { productId: productId };
                -                                await sessionService.setSession(psid, userSession);
                -                                return 'এই পণ্যটি অর্ডার করতে, অনুগ্রহ করে আপনার সম্পূর্ণ নাম লিখুন।';
                -                            }
                -                        },
                -                        { // ইন্টেন্ট: provide_contact_info (নাম)
                -                            condition: () => userSession.state === 'awaiting_name',
                -                            action: async () => {
                -                                // যদি এনটিটি থেকে নাম পাওয়া যায়, সেটি ব্যবহার করুন
                -                                userSession.order.customerName = entities.customerName || incomingMessageText;
                -                                userSession.state = 'awaiting_phone';
                -                                await sessionService.setSession(psid, userSession);
                -                
                -                                // যদি একই বার্তায় ফোন নম্বরও থাকে, তাহলে পরবর্তী ধাপে যান
                -                                if (entities.phone) {
                -                                    return await processNextState(psid, userSession, entities.phone, pageAccessToken);
                -                                }
                -                                return 'ধন্যবাদ! এখন আপনার ফোন নম্বরটি দিন (যেমন: 01xxxxxxxxx)।';
                -                            }
                -                        },
                -                        { // ইন্টেন্ট: provide_contact_info (ফোন)
                -                            condition: () => userSession.state === 'awaiting_phone',
                -                            action: async ()।';
                -                                }
                -                            }
                -                        },
                -                        {
                -                            // ইন্টেন্ট: provide_contact_info (ঠিকানা)
                -                            condition: () => userSession.state === 'awaiting_address',
                -                            action: async () => {
                -                                userSession.order.address = entities.address || incomingMessageText;
                -                                const product = await Product.findById(userSession.order.productId);
                -                                if (!product) {
                -                                    await sessionService.deleteSession(psid);
                -                                    return 'দুঃখিত, এই পণ্যটি আর উপলব্ধ নেই।';
                -                                }
                -                                const customer = await Customer.findOneAndUpdate(
                -                                    { psid: psid, pageId: pageId },
                -                                    { name: userSession.order.customerName, phone: userSession.order.phone, address: userSession.order.address },
                -                                    { upsert: true, new: true }
                -                                );
                -                                const newOrder = new Order({
                -                                    pageId: pageId, customerId: customer._id,
                -                                    products: [{ productId: product._id, quantity: 1, price: product.price }],
                -                                    totalAmount: product.price, status: 'pending',
                -                                    shippingAddress: userSession.order.address,
                -                                    customerInfo: { name: userSession.order.customerName, phone: userSession.order.phone },
                -                                });
                -                                await newOrder.save();
                -                                await sessionService.deleteSession(psid);
                -                                return `আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে! আপনার অর্ডার আইডি হলো: ${newOrder._id}। আমাদের একজন প্রতিনিধি শীঘ্রই আপনার সাথে যোগাযোগ করবে।`;
                -                            }
                -                        },
                -                        // অন্যান্য কীওয়ার্ড
                -                        {
                -                            condition: () => intent === 'cancel_order' || incomingMessageText.startsWith('CANCEL_ORDER_'),
                -                            action: async () => {
                -                                const orderId = incomingMessageText.split('_')[1];
                -                                const order = await Order.findById(orderId);
                -                                if (order && (order.status === 'pending' || order.status === 'confirmed')) {
                -                                    order.status = 'cancelled';
                -                                    await order.save();
                -                                    return `আপনার অর্ডার (ID: ) সফলভাবে বাতিল করা হয়েছে।`;
                -                                } else {
                -                                    return `দুঃখিত, এই অর্ডারটি আর বাতিল করা সম্ভব নয়।`;
                -                                }
                -                            }
                -                        },
                -                        {
                -                            condition: () => intent === 'track_order',
                -                            action: async () => {
                -                                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                -                                if (!customer) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি। নতুন অর্ডার করতে "products" লিখে পাঠান।';
                -                                
                -                                const latestOrder = await Order.findOne({ customerId: customer._id }).sort({ createdAt: -1 });
                -                                if (!latestOrder) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি।';
                -                
                -                                const orderInfoText = `আপনার সর্বশেষ অর্ডারের তথ্য নিচে দেওয়া হলো:\n\n` +
                -                                                    `অর্ডার আইডি: ${latestOrder._id}\n` +
                -                                                    `মোট পরিমাণ: ${latestOrder.totalAmount} BDT\n` +
                -                                                    `স্ট্যাটাস: ${latestOrder.status}`;
                -                
                -                                if (latestOrder.status === 'pending' || latestOrder.status === 'confirmed') {
                -                                    const buttons = [{ type: 'postback', title: 'Cancel Order', payload: `CANCEL_ORDER_${latestOrder._id}` }];
                -                                    await facebookService.sendButtonTemplate(psid, orderInfoText, buttons, pageAccessToken);
                -                                    return null; // যেহেতু একটি টেমপ্লেট পাঠানো হয়েছে, তাই কোনো টেক্সট রিপ্লাই নেই
                -                                }
                -                                return orderInfoText;
                -                            }
                -                        },
                -                        {
                -                            condition: () => intent === 'show_products',
                -                            action: async () => {
                -                                const products = await Product.find({ pageId }).limit(10);
                -                                if (products && products.length > 0) {
                -                                    const elements = products.map(p => ({
                -                                        title: p.name, subtitle: `Price: ${p.price} BDT\nStock: ${p.stock}`, image_url: p.imageUrl,
                -                                        buttons: [
                -                                            { type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` },
                -                                            { type: 'web_url', url: 'https://your-website.com/contact', title: 'Contact Us' },
                -                                        ],
                -                                    }));
                -                                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                    return null; // টেমপ্লেট পাঠানো হয়েছে
                -                                }
                -                                return 'দুঃখিত, এই মুহূর্তে দোকানে কোনো পণ্য উপলব্ধ নেই।';
                -                            }
                -                        },
                -                    ];
                -                
                -                    // একটি helper ফাংশন যা অর্ডার ফ্লোতে পরবর্তী ধাপে যেতে সাহায্য করবে
                -                    const processNextState = async (psid, session, data, token) => {
                -                        const processor = new MessageProcessor(jobData); // একটি কাল্পনিক ক্লাস যা processMessage লজিক ধারণ করে
                -                        return await processor.processMessageWithIntent(data); // একটি কাল্পনিক মেথড
                -                    };
                -                
                -                    for (const rule of messageRouter) {
                -                        if (rule.condition()) {
                -                            replyText = await rule.action();
                -                            break; // প্রথম ম্যাচ করা রুলেই থেমে যান
                -                        }
                -                    }
                -                
                -                    // ধাপ ৩: AI-ভিত্তিক ফলব্যাক
                -                    // যদি কোনো নিয়ম না মেলে এবং কোনো সেশন স্টেট না থাকে, অথবা ইন্টেন্ট যদি 'general_question' হয়
                -                    if ((replyText === '' && !userSession.state) || intent === 'general_question') {
                -                        const queryForAI = incomingMessageText;
                -                        console.log(`Forwarding to AI with query: ""`);
                -                
                -                        // কথোপকথনের ইতিহাস তৈরি করুন
                -                        const recentMessages = await ChatLog.find({ pageId, psid })
                -                            .sort({ timestamp: -1 })
                -                            .limit(10);
                -                        
                -                        const history = recentMessages.reverse().map(log => ({
                -                            role: log.sender === 'user' ? 'user' : 'assistant',
                -                            content: log.message?.text || '(Attachment or unknown message)',
                -                        }));
                -                
                -                        // ডাটাবেস থেকে প্রোডাক্টগুলো আনুন যাতে এআই জানে কী কী প্রোডাক্ট আছে
                -                        const products = await Product.find({ pageId }).limit(20);
                -                        let productContext = "";
                -                        if (products && products.length > 0) {
                -                            productContext = "\n\n--- আপনার দোকানের বর্তমান প্রোডাক্ট তালিকা ---\n";
                -                            products.forEach(p => {
                -                                productContext += `- ${p.name} (দাম: ${p.price} BDT, স্টক: ${p.stock})\n`;
                -                                if (p.description) productContext += `  বিবরণ: ${p.description}\n`;
                -                            });
                -                            productContext += "\nকাস্টমার যদি কোনো প্রোডাক্ট বা দাম সম্পর্কে জানতে চায়, উপরের তালিকা থেকে তথ্য দেবে। যদি বিস্তারিত ছবি দেখতে চায়, তবে কাস্টমারকে 'products' শব্দটি লিখে সেন্ড করতে বলবে, তাহলে সিস্টেম অটোমেটিক ছবিসহ প্রোডাক্ট পাঠাবে।";
                -                        }
                -                
                -                        // কাস্টম প্রম্পট থেকে [আপনার পেজের নাম] লেখাটি রিপ্লেস করে আসল পেজের নাম বসিয়ে দিন
                -                        let systemPromptText = page.aiSystemPrompt || "";
                -                        systemPromptText = systemPromptText.replace(/\[আপনার পেজের নাম\]/g, page.name);
                -                
                -                        const finalPrompt = systemPromptText + productContext;
                -                
                -                        replyText = await aiService.getAIResponse(finalPrompt, [...history, { role: 'user', content: queryForAI }]);
                -                    }
                -                
                -                    // ধাপ ৪: ব্যবহারকারীকে উত্তর পাঠান
                -                    // "Please respond..." বার্তাটি ব্যবহারকারীকে পাঠানো হবে না
                -                    if (replyText) {
                -                        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
                -                        // বটের উত্তর চ্যাট লগে সংরক্ষণ করুন
                -                        const botMessage = await ChatLog.create({ pageId, psid, sender: 'bot', message: { text: replyText } });
                -                        // বটের উত্তর ব্রডকাস্ট করুন
                -                        broadcastToPage(pageId, botMessage);
                -                        return true; // সফলভাবে প্রসেসড
                -                    }
                -                
                -                    // যদি কোনো উত্তর তৈরি না হয়, তাহলে একটি লগ প্রিন্ট করুন
                -                    console.log(`[Processor] No reply generated for message: "". Current session state: ${userSession.state || 'none'}.`);
                -                    // কোনো উত্তর পাঠানো হয়নি, তাই জবটি সফল হিসেবে গণ্য হবে না এবং পুনরায় চেষ্টা করা হতে পারে।
                -                    // এটিকে true করলে জবটি সফল হিসেবে গণ্য হবে এবং পুনরায় চেষ্টা করা হবে না।
                -                    return true; // কোনো উত্তর না থাকলেও জবটিকে সফল হিসেবে চিহ্নিত করুন, যাতে এটি বারবার রান না করে।
                -                };
                -                
                -                module.exports = { processMessage };{
                -                  "mappings": {
                -                    "dynamic": false,
                -                    "fields": {
                -                      "description": {
                -                        "type": "string"
                -                      },
                -                      "name": {
                -                        "type": "string"
                -                      }
                -                    }
                -                  }
                -                }
                -                 });
                +                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                                 if (!customer) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি। নতুন অর্ডার করতে "products" লিখে পাঠান।';
                                 
                                 const latestOrder = await Order.findOne({ customerId: customer._id }).sort({ createdAt: -1 });
                
                --- a/d:/allproject/facebookbot/chatbot/messageProcessor.js
                +++ b/d:/allproject/facebookbot/chatbot/messageProcessor.js
                @@ -232,185 +232,7 @@
                         {
                             condition: () => intent === 'track_order',
                             action: async () => {
                -                const customer = await Customer.findOne({ psid: psid, pageId: pageIdconst Page = require('./Page');
                -                const ChatLog = require('./ChatLog');
                -                const Product = require('./Product');
                -                const Order = require('./Order');
                -                const Customer = require('./Customer');
                -                const facebookService = require('./facebookService'); // This should be './facebookService'
                -                const { broadcastToPage } = require('./websocket');
                -                const aiService = require('./aiService');
                -                const sessionService = require('./sessionService');
                -                
                -                const processMessage = async (jobData) => {
                -                    const { type, pageId, psid, message, postback } = jobData;
                -                
                -                    // ধাপ ১: পেজের তথ্য এবং অ্যাক্সেস টোকেন আনুন
                -                    const page = await Page.findOne({ pageId }).select('+pageAccessToken +humanTakeover +aiSystemPrompt');
                -                    if (!page) {
                -                        console.error(`Page with ID ${pageId} not found.`);
                -                        return false; // প্রসেসিং ব্যর্থ
                -                    }
                -                    const pageAccessToken = facebookService.decryptToken(page.pageAccessToken);
                -                
                -                    // ধাপ ১.১: অ্যাটাচমেন্ট (ছবি) হ্যান্ডেল করুন
                -                    if (type === 'message' && message.attachments && message.attachments.length > 0) {
                -                        const attachment = message.attachments[0];
                -                        if (attachment.type === 'image' && !page.humanTakeover) {
                -                            console.log(`[Visual Search] Received image from user . URL: ${attachment.payload.url}`);
                -                            
                -                            // ১. ছবি থেকে সার্চের জন্য বর্ণনা তৈরি করুন
                -                            const searchKeywords = await aiService.getImageDescriptionForSearch(attachment.payload.url);
                -                            console.log(`[Visual Search] Keywords from AI: ""`);
                -                
                -                            if (searchKeywords) {
                -                                // ২. ডাটাবেসে Atlas Search ব্যবহার করে সার্চ করুন
                -                                const matchedProducts = await Product.aggregate([
                -                                    {
                -                                        : {
                -                                            index: 'product_search', // Atlas UI-তে তৈরি করা ইনডেক্সের নাম
                -                                            text: {
                -                                                query: searchKeywords,
                -                                                path: ['name', 'description'], // যে ফিল্ডগুলোতে সার্চ করতে হবে
                -                                                fuzzy: { // টাইপো বা ছোটখাটো ভুল বানান ঠিক করার জন্য
                -                                                    maxEdits: 1,
                -                                                    prefixLength: 2
                -                                                }
                -                                            }
                -                                        }
                -                                    },
                -                                    {
                -                                        : { pageId: pageId } // সার্চ ফলাফলের পর পেজ আইডি দিয়ে ফিল্টার করুন
                -                                    },
                -                                    { : 5 }, // ফলাফলের সংখ্যা ৫-এর মধ্যে সীমাবদ্ধ রাখুন
                -                                    { : { score: { : "searchScore" } } } // প্রাসঙ্গিকতা স্কোর যোগ করুন (ঐচ্ছিক)
                -                                ]);
                -                
                -                                if (matchedProducts.length > 0) {
                -                                    // ৩. ম্যাচ পাওয়া গেলে
                -                                    await facebookService.sendTextMessage(psid, "আপনার পাঠানো ছবির সাথে মিলে যাওয়া কিছু পণ্য নিচে দেওয়া হলো:", pageAccessToken);
                -                                    const elements = matchedProducts.map(p => ({
                -                                        title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: p.imageUrl,
                -                                        buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                -                                    }));
                -                                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                } else {
                -                                    // ৪. ম্যাচ না পাওয়া গেলে
                -                                    await facebookService.sendTextMessage(psid, "দুঃখিত, আপনার পাঠানো ছবির পণ্যটি আমাদের সংগ্রহে নেই। তবে, আমাদের অন্যান্য জনপ্রিয় কিছু পণ্য নিচে দেখুন:", pageAccessToken);
                -                                    const otherProducts = await Product.find({ pageId: pageId }).sort({ createdAt: -1 }).limit(5);
                -                                    if (otherProducts.length > 0) {
                -                                        const elements = otherProducts.map(p => ({
                -                                            title: p.name, subtitle: `Price: ${p.price} BDT`, image_url: p.imageUrl,
                -                                            buttons: [{ type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` }],
                -                                        }));
                -                                        await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                    }
                -                                }
                -                            }
                -                            return true; // ছবি প্রসেস করা শেষ
                -                        }
                -                    }
                -                
                -                    // পোস্টব্যাক বা মেসেজ থেকে টেক্সট নিন
                -                    const incomingMessageText = type === 'message' && message.text
                -                        ? message.text.toLowerCase().trim() 
                -                        : (postback && postback.payload ? postback.payload : '');
                -                
                -                    // Redis থেকে বর্তমান ব্যবহারকারীর সেশন আনুন
                -                    const userSession = await sessionService.getSession(psid) || {};
                -                
                -                    // যদি Human Takeover সক্রিয় থাকে, তাহলে বট কোনো উত্তর দেবে না
                -                    if (page.humanTakeover) {
                -                        console.log(`Human takeover is active for page . Bot is silent.`);
                -                        return true; // সফলভাবে প্রসেসড, কিন্তু কোনো উত্তর নেই
                -                    }
                -                
                -                    // ধাপ ১.২: AI ব্যবহার করে ইন্টেন্ট এবং এনটিটি সনাক্ত করুন
                -                    const { intent, entities, confidence } = await aiService.getIntentAndEntities(incomingMessageText);
                -                    console.log(`[AI Intent] Intent: , Entities: ${JSON.stringify(entities)}, Confidence: `);
                -                
                -                    // ব্যবহারকারীর মেসেজটি চ্যাট লগে সংরক্ষণ করুন
                -                    if (type === 'message') {
                -                        const savedMessage = await ChatLog.create({ pageId, psid, sender: 'user', message: { text: message.text } });
                -                        // নতুন মেসেজ ব্রডকাস্ট করুন
                -                        broadcastToPage(pageId, savedMessage);
                -                    }
                -                
                -                    let replyText = ''; // replyText-কে একটি খালি স্ট্রিং দিয়ে শুরু করুন
                -                
                -                    // ধাপ ১.৫: যেকোনো পর্যায়ে অর্ডার বাতিল করার সুযোগ
                -                    if (userSession.state && incomingMessageText === 'cancel') {
                -                        await sessionService.deleteSession(psid);
                -                        replyText = 'আপনার অর্ডার প্রক্রিয়াটি বাতিল করা হয়েছে। নতুন করে শুরু করতে "products" লিখে পাঠান।';
                -                        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
                -                        return true; // সফলভাবে প্রসেসড
                -                    }
                -                
                -                    // ধাপ ২: নিয়ম-ভিত্তিক রাউটিং এর জন্য একটি রাউটার তৈরি করুন
                -                    const messageRouter = [
                -                        // অর্ডার ফ্লো
                -                        { // ইন্টেন্ট: start_order অথবা BUY_ পোস্টব্যাক
                -                            condition: () => incomingMessageText.startsWith('BUY_'),
                -                            action: async () => {
                -                                const productId = incomingMessageText.split('_')[1];
                -                                userSession.state = 'awaiting_name';
                -                                userSession.order = { productId: productId };
                -                                await sessionService.setSession(psid, userSession);
                -                                return 'এই পণ্যটি অর্ডার করতে, অনুগ্রহ করে আপনার সম্পূর্ণ নাম লিখুন।';
                -                            }
                -                        },
                -                        { // ইন্টেন্ট: provide_contact_info (নাম)
                -                            condition: () => userSession.state === 'awaiting_name',
                -                            action: async () => {
                -                                // যদি এনটিটি থেকে নাম পাওয়া যায়, সেটি ব্যবহার করুন
                -                                userSession.order.customerName = entities.customerName || incomingMessageText;
                -                                userSession.state = 'awaiting_phone';
                -                                await sessionService.setSession(psid, userSession);
                -                
                -                                // যদি একই বার্তায় ফোন নম্বরও থাকে, তাহলে পরবর্তী ধাপে যান
                -                                if (entities.phone) {
                -                                    return await processNextState(psid, userSession, entities.phone, pageAccessToken);
                -                                }
                -                                return 'ধন্যবাদ! এখন আপনার ফোন নম্বরটি দিন (যেমন: 01xxxxxxxxx)।';
                -                            }
                -                        },
                -                        { // ইন্টেন্ট: provide_contact_info (ফোন)
                -                            condition: () => userSession.state === 'awaiting_phone',
                -                            action: async ()।';
                -                                }
                -                            }
                -                        },
                -                        {
                -                            // ইন্টেন্ট: provide_contact_info (ঠিকানা)
                -                            condition: () => userSession.state === 'awaiting_address',
                -                            action: async () => {
                -                                userSession.order.address = entities.address || incomingMessageText;
                -                                const product = await Product.findById(userSession.order.productId);
                -                                if (!product) {
                -                                    await sessionService.deleteSession(psid);
                -                                    return 'দুঃখিত, এই পণ্যটি আর উপলব্ধ নেই।';
                -                                }
                -                                const customer = await Customer.findOneAndUpdate(
                -                                    { psid: psid, pageId: pageId },
                -                                    { name: userSession.order.customerName, phone: userSession.order.phone, address: userSession.order.address },
                -                                    { upsert: true, new: true }
                -                                );
                -                                const newOrder = new Order({
                -                                    pageId: pageId, customerId: customer._id,
                -                                    products: [{ productId: product._id, quantity: 1, price: product.price }],
                -                                    totalAmount: product.price, status: 'pending',
                -                                    shippingAddress: userSession.order.address,
                -                                    customerInfo: { name: userSession.order.customerName, phone: userSession.order.phone },
                -                                });
                -                                await newOrder.save();
                -                                await sessionService.deleteSession(psid);
                -                                return `আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে! আপনার অর্ডার আইডি হলো: ${newOrder._id}। আমাদের একজন প্রতিনিধি শীঘ্রই আপনার সাথে যোগাযোগ করবে।`;
                -                            }
                -                        },
                -                        // অন্যান্য কীওয়ার্ড
                -                        {
                -                            condition: () => intent === 'cancel_order' || incomingMessageText.startsWith('CANCEL_ORDER_'),
                -                            action: async () => {
                -                                const orderId = incomingMessageText.split('_')[1];
                -                                const order = await Order.findById(orderId);
                -                                if (order && (order.status === 'pending' || order.status === 'confirmed')) {
                -                                    order.status = 'cancelled';
                -                                    await order.save();
                -                                    return `আপনার অর্ডার (ID: ) সফলভাবে বাতিল করা হয়েছে।`;
                -                                } else {
                -                                    return `দুঃখিত, এই অর্ডারটি আর বাতিল করা সম্ভব নয়।`;
                -                                }
                -                            }
                -                        },
                -                        {
                -                            condition: () => intent === 'track_order',
                -                            action: async () => {
                -                                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                -                                if (!customer) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি। নতুন অর্ডার করতে "products" লিখে পাঠান।';
                -                                
                -                                const latestOrder = await Order.findOne({ customerId: customer._id }).sort({ createdAt: -1 });
                -                                if (!latestOrder) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি।';
                -                
                -                                const orderInfoText = `আপনার সর্বশেষ অর্ডারের তথ্য নিচে দেওয়া হলো:\n\n` +
                -                                                    `অর্ডার আইডি: ${latestOrder._id}\n` +
                -                                                    `মোট পরিমাণ: ${latestOrder.totalAmount} BDT\n` +
                -                                                    `স্ট্যাটাস: ${latestOrder.status}`;
                -                
                -                                if (latestOrder.status === 'pending' || latestOrder.status === 'confirmed') {
                -                                    const buttons = [{ type: 'postback', title: 'Cancel Order', payload: `CANCEL_ORDER_${latestOrder._id}` }];
                -                                    await facebookService.sendButtonTemplate(psid, orderInfoText, buttons, pageAccessToken);
                -                                    return null; // যেহেতু একটি টেমপ্লেট পাঠানো হয়েছে, তাই কোনো টেক্সট রিপ্লাই নেই
                -                                }
                -                                return orderInfoText;
                -                            }
                -                        },
                -                        {
                -                            condition: () => intent === 'show_products',
                -                            action: async () => {
                -                                const products = await Product.find({ pageId }).limit(10);
                -                                if (products && products.length > 0) {
                -                                    const elements = products.map(p => ({
                -                                        title: p.name, subtitle: `Price: ${p.price} BDT\nStock: ${p.stock}`, image_url: p.imageUrl,
                -                                        buttons: [
                -                                            { type: 'postback', title: 'Buy Now', payload: `BUY_${p._id}` },
                -                                            { type: 'web_url', url: 'https://your-website.com/contact', title: 'Contact Us' },
                -                                        ],
                -                                    }));
                -                                    await facebookService.sendGenericTemplate(psid, elements, pageAccessToken);
                -                                    return null; // টেমপ্লেট পাঠানো হয়েছে
                -                                }
                -                                return 'দুঃখিত, এই মুহূর্তে দোকানে কোনো পণ্য উপলব্ধ নেই।';
                -                            }
                -                        },
                -                    ];
                -                
                -                    // একটি helper ফাংশন যা অর্ডার ফ্লোতে পরবর্তী ধাপে যেতে সাহায্য করবে
                -                    const processNextState = async (psid, session, data, token) => {
                -                        const processor = new MessageProcessor(jobData); // একটি কাল্পনিক ক্লাস যা processMessage লজিক ধারণ করে
                -                        return await processor.processMessageWithIntent(data); // একটি কাল্পনিক মেথড
                -                    };
                -                
                -                    for (const rule of messageRouter) {
                -                        if (rule.condition()) {
                -                            replyText = await rule.action();
                -                            break; // প্রথম ম্যাচ করা রুলেই থেমে যান
                -                        }
                -                    }
                -                
                -                    // ধাপ ৩: AI-ভিত্তিক ফলব্যাক
                -                    // যদি কোনো নিয়ম না মেলে এবং কোনো সেশন স্টেট না থাকে, অথবা ইন্টেন্ট যদি 'general_question' হয়
                -                    if ((replyText === '' && !userSession.state) || intent === 'general_question') {
                -                        const queryForAI = incomingMessageText;
                -                        console.log(`Forwarding to AI with query: ""`);
                -                
                -                        // কথোপকথনের ইতিহাস তৈরি করুন
                -                        const recentMessages = await ChatLog.find({ pageId, psid })
                -                            .sort({ timestamp: -1 })
                -                            .limit(10);
                -                        
                -                        const history = recentMessages.reverse().map(log => ({
                -                            role: log.sender === 'user' ? 'user' : 'assistant',
                -                            content: log.message?.text || '(Attachment or unknown message)',
                -                        }));
                -                
                -                        // ডাটাবেস থেকে প্রোডাক্টগুলো আনুন যাতে এআই জানে কী কী প্রোডাক্ট আছে
                -                        const products = await Product.find({ pageId }).limit(20);
                -                        let productContext = "";
                -                        if (products && products.length > 0) {
                -                            productContext = "\n\n--- আপনার দোকানের বর্তমান প্রোডাক্ট তালিকা ---\n";
                -                            products.forEach(p => {
                -                                productContext += `- ${p.name} (দাম: ${p.price} BDT, স্টক: ${p.stock})\n`;
                -                                if (p.description) productContext += `  বিবরণ: ${p.description}\n`;
                -                            });
                -                            productContext += "\nকাস্টমার যদি কোনো প্রোডাক্ট বা দাম সম্পর্কে জানতে চায়, উপরের তালিকা থেকে তথ্য দেবে। যদি বিস্তারিত ছবি দেখতে চায়, তবে কাস্টমারকে 'products' শব্দটি লিখে সেন্ড করতে বলবে, তাহলে সিস্টেম অটোমেটিক ছবিসহ প্রোডাক্ট পাঠাবে।";
                -                        }
                -                
                -                        // কাস্টম প্রম্পট থেকে [আপনার পেজের নাম] লেখাটি রিপ্লেস করে আসল পেজের নাম বসিয়ে দিন
                -                        let systemPromptText = page.aiSystemPrompt || "";
                -                        systemPromptText = systemPromptText.replace(/\[আপনার পেজের নাম\]/g, page.name);
                -                
                -                        const finalPrompt = systemPromptText + productContext;
                -                
                -                        replyText = await aiService.getAIResponse(finalPrompt, [...history, { role: 'user', content: queryForAI }]);
                -                    }
                -                
                -                    // ধাপ ৪: ব্যবহারকারীকে উত্তর পাঠান
                -                    // "Please respond..." বার্তাটি ব্যবহারকারীকে পাঠানো হবে না
                -                    if (replyText) {
                -                        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
                -                        // বটের উত্তর চ্যাট লগে সংরক্ষণ করুন
                -                        const botMessage = await ChatLog.create({ pageId, psid, sender: 'bot', message: { text: replyText } });
                -                        // বটের উত্তর ব্রডকাস্ট করুন
                -                        broadcastToPage(pageId, botMessage);
                -                        return true; // সফলভাবে প্রসেসড
                -                    }
                -                
                -                    // যদি কোনো উত্তর তৈরি না হয়, তাহলে একটি লগ প্রিন্ট করুন
                -                    console.log(`[Processor] No reply generated for message: "". Current session state: ${userSession.state || 'none'}.`);
                -                    // কোনো উত্তর পাঠানো হয়নি, তাই জবটি সফল হিসেবে গণ্য হবে না এবং পুনরায় চেষ্টা করা হতে পারে।
                -                    // এটিকে true করলে জবটি সফল হিসেবে গণ্য হবে এবং পুনরায় চেষ্টা করা হবে না।
                -                    return true; // কোনো উত্তর না থাকলেও জবটিকে সফল হিসেবে চিহ্নিত করুন, যাতে এটি বারবার রান না করে।
                -                };
                -                
                -                module.exports = { processMessage };{
                -                  "mappings": {
                -                    "dynamic": false,
                -                    "fields": {
                -                      "description": {
                -                        "type": "string"
                -                      },
                -                      "name": {
                -                        "type": "string"
                -                      }
                -                    }
                -                  }
                -                }
                -                 });
                +                const customer = await Customer.findOne({ psid: psid, pageId: pageId });
                                 if (!customer) return 'আপনার কোনো অর্ডার আমাদের কাছে খুঁজে পাওয়া যায়নি। নতুন অর্ডার করতে "products" লিখে পাঠান।';
                                 
                                 const latestOrder = await Order.findOne({ customerId: customer._id }).sort({ createdAt: -1 });
                
                 });
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
            condition: () => intent === 'show_products',
            action: async () => {
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

    // একটি helper ফাংশন যা অর্ডার ফ্লোতে পরবর্তী ধাপে যেতে সাহায্য করবে
    const processNextState = async (psid, session, data, token) => {
        const processor = new MessageProcessor(jobData); // একটি কাল্পনিক ক্লাস যা processMessage লজিক ধারণ করে
        return await processor.processMessageWithIntent(data); // একটি কাল্পনিক মেথড
    };

    for (const rule of messageRouter) {
        if (rule.condition()) {
            replyText = await rule.action();
            break; // প্রথম ম্যাচ করা রুলেই থেমে যান
        }
    }

    // ধাপ ৩: AI-ভিত্তিক ফলব্যাক
    // যদি কোনো নিয়ম না মেলে এবং কোনো সেশন স্টেট না থাকে, অথবা ইন্টেন্ট যদি 'general_question' হয়
    if ((replyText === '' && !userSession.state) || intent === 'general_question') {
        const queryForAI = incomingMessageText;

        // AI রেসপন্স লিমিট চেক করুন
        const user = await User.findById(page.ownerId);
        const plan = user.subscriptionPlan;
        if (plan.aiResponsesUsed >= plan.aiResponseLimit) {
            console.log(`[Limit Reached] User ${user.name} has reached their AI response limit.`);
            replyText = `দুঃখিত, আপনার AI রেসপন্স লিমিট শেষ হয়ে গেছে। সার্ভিসটি চালিয়ে যেতে অনুগ্রহ করে আপনার প্ল্যান আপগ্রেড করুন।`;
            await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
            return true; // প্রসেসিং সফল, কিন্তু লিমিট শেষ
        }

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
        systemPromptText = systemPromptText.replace(/\[shop_name\]/g, page.name);

        // AI-এর জন্য একটি বেস আইডেন্টিটি তৈরি করুন
        const baseIdentity = "Your name is Snigda (স্নিগ্ধা). You must politely introduce yourself as Snigda in Bengali when a user says 'hi', 'hello', or asks for your name. CRITICAL RULE: NEVER start your response with the shop's name as a header or title. Write naturally like a human in a chat message.";

        const finalPrompt = `${systemPromptText}\n${productContext}\n\n${baseIdentity}`;

        replyText = await aiService.getAIResponse(finalPrompt, [...history, { role: 'user', content: queryForAI }]);

        // AI রেসপন্স কাউন্ট বৃদ্ধি করুন
        try {
            await User.findByIdAndUpdate(page.ownerId, {
                $inc: { 'subscriptionPlan.aiResponsesUsed': 1 }
            });
        } catch (err) {
            console.error('Failed to increment AI response count:', err);
        }
    }

    // ধাপ ৪: ব্যবহারকারীকে উত্তর পাঠান
    // "Please respond..." বার্তাটি ব্যবহারকারীকে পাঠানো হবে না
    if (replyText) {
        await facebookService.sendTextMessage(psid, replyText, pageAccessToken);
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