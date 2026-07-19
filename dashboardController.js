const Order = require('./Order');
const Page = require('./Page');
const Customer = require('./Customer');
const facebookService = require('./facebookService');
const ChatLog = require('./ChatLog');

/**
 * একটি নির্দিষ্ট পেজের জন্য অর্ডার নিয়ে আসে, মালিকানা যাচাই করে।
 */
exports.getOrdersForPage = async (req, res) => {
    try {
        const { pageId } = req.params;
        const userId = req.user._id; // authMiddleware থেকে প্রাপ্ত

        // ১. যাচাই করুন যে ব্যবহারকারী এই পেজের মালিক
        const page = await Page.findOne({ pageId: pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have access to this page's orders." });
        }

        // ২. সাম্প্রতিকতম অনুযায়ী সাজিয়ে অর্ডারগুলো আনুন
        const orders = await Order.find({ pageId: pageId })
            .populate('customerId', 'name phone') // গ্রাহকের নাম ও ফোন নম্বর যোগ করুন
            .populate('products.productId', 'name price') // Populate product details
            .sort({ createdAt: -1 });

        res.status(200).json(orders);
    } catch (error) {
        console.error("Error fetching orders for dashboard:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * একটি নির্দিষ্ট পেজের জন্য গ্রাহকদের তালিকা নিয়ে আসে।
 * ট্যাগ দ্বারা ফিল্টার করা যেতে পারে।
 */
exports.getCustomersForPage = async (req, res) => {
    try {
        const { pageId } = req.params;
        const { tags } = req.query; // ?tags=vip,new
        const userId = req.user._id;

        // ১. পেজের মালিকানা যাচাই করুন
        const page = await Page.findOne({ pageId: pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have access to this page's customers." });
        }

        // ২. ফিল্টার কোয়েরি তৈরি করুন
        let filterQuery = { pageId: pageId };
        if (tags) {
            const tagsArray = tags.split(',').map(tag => tag.trim().toLowerCase());
            if (tagsArray.length > 0) {
                // যে গ্রাহকদের সব ট্যাগ আছে তাদের খুঁজুন
                filterQuery.tags = { $all: tagsArray };
            }
        }

        // ৩. সাম্প্রতিকতম অনুযায়ী সাজিয়ে গ্রাহকদের তালিকা আনুন
        const customers = await Customer.find(filterQuery).sort({ createdAt: -1 });

        res.status(200).json(customers);
    } catch (error) {
        console.error("Error fetching customers for page:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * একটি নির্দিষ্ট পেজের জন্য ড্যাশবোর্ড সারাংশ তৈরি করে।
 */
exports.getDashboardSummary = async (req, res) => {
    try {
        const { pageId } = req.params;
        const userId = req.user._id;

        // ১. পেজের মালিকানা যাচাই করুন
        const page = await Page.findOne({ pageId: pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have access to this page." });
        }

        // ২. অ্যাগ্রিগেশন পাইপলাইন ব্যবহার করে সারাংশ গণনা করুন
        const summary = await Order.aggregate([
            { $match: { pageId: pageId } }, // শুধুমাত্র নির্দিষ্ট পেজের অর্ডার ফিল্টার করুন
            {
                $group: {
                    _id: null, // সমস্ত ম্যাচ করা ডকুমেন্টকে একটি গ্রুপে রাখুন
                    totalOrders: { $sum: 1 },
                    totalRevenue: {
                        $sum: {
                            // শুধুমাত্র 'delivered' স্ট্যাটাসের অর্ডারের আয় যোগ করুন
                            $cond: [{ $eq: ['$status', 'delivered'] }, '$totalAmount', 0]
                        }
                    },
                    potentialRevenue: {
                        $sum: {
                            $cond: [{ $in: ['$status', ['confirmed', 'shipped']] }, '$totalAmount', 0]
                        }
                    },
                    pendingOrders: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'pending'] }, 1, 0]
                        }
                    }
                }
            }
        ]);

        // ৩. ফলাফল ফরম্যাট করুন
        const result = summary[0] || {
            totalOrders: 0,
            totalRevenue: 0,
            potentialRevenue: 0,
            pendingOrders: 0,
        };

        // অতিরিক্ত অ্যানালিটিক্স যোগ করুন
        const totalCustomers = await Customer.countDocuments({ pageId: pageId });

        const messageStats = await ChatLog.aggregate([
            { $match: { pageId: pageId } },
            {
                $group: {
                    _id: "$sender",
                    count: { $sum: 1 }
                }
            }
        ]);

        const topProducts = await Order.aggregate([
            { $match: { pageId: pageId, status: 'delivered' } },
            { $unwind: "$products" },
            {
                $group: {
                    _id: "$products.productId",
                    totalSold: { $sum: "$products.quantity" }
                }
            },
            { $sort: { totalSold: -1 } },
            { $limit: 5 },
            {
                $lookup: {
                    from: 'products', // 'products' collection
                    localField: '_id',
                    foreignField: '_id',
                    as: 'productDetails'
                }
            },
            { $unwind: "$productDetails" }
        ]);

        result.totalCustomers = totalCustomers;
        result.messageStats = messageStats;
        result.topProducts = topProducts;

        res.status(200).json(result);
    } catch (error) {
        console.error("Error fetching dashboard summary:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * একটি নির্দিষ্ট পেজের জন্য দৈনিক আয় নিয়ে আসে।
 */
exports.getDailyRevenue = async (req, res) => {
    try {
        const { pageId } = req.params;
        const userId = req.user._id;

        const page = await Page.findOne({ pageId: pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have access to this page." });
        }

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const revenueData = await Order.aggregate([
            { 
                $match: { 
                    pageId: pageId, 
                    status: 'delivered', 
                    createdAt: { $gte: thirtyDaysAgo } 
                } 
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                    revenue: { $sum: "$totalAmount" }
                }
            },
            { $sort: { _id: 1 } },
            {
                $project: {
                    _id: 0,
                    date: "$_id",
                    revenue: 1
                }
            }
        ]);

        res.status(200).json(revenueData);
    } catch (error) {
        console.error("Error fetching daily revenue:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * একটি নির্দিষ্ট গ্রাহককে ট্যাগ করে বা ট্যাগ আপডেট করে।
 */
exports.tagCustomer = async (req, res) => {
    try {
        const { customerId } = req.params;
        const { tags } = req.body; // একটি স্ট্রিং অ্যারে আশা করা হচ্ছে
        const userId = req.user._id;

        if (!Array.isArray(tags)) {
            return res.status(400).json({ message: 'Tags must be an array of strings.' });
        }

        // ১. গ্রাহককে খুঁজুন
        const customer = await Customer.findById(customerId);
        if (!customer) {
            return res.status(404).json({ message: 'Customer not found.' });
        }

        // ২. যাচাই করুন যে ব্যবহারকারী এই গ্রাহকের সংশ্লিষ্ট পেজের মালিক
        const page = await Page.findOne({ pageId: customer.pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have permission to tag this customer." });
        }

        // ৩. ট্যাগ আপডেট করুন এবং সেভ করুন
        customer.tags = tags.map(tag => tag.toLowerCase().trim()); // ট্যাগ নরম্যালাইজ করুন
        await customer.save();

        res.status(200).json({ message: 'Customer tags updated successfully.', customer });
    } catch (error) {
        console.error("Error updating customer tags:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};