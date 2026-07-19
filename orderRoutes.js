const express = require('express');
const Order = require('./Order');
const Page = require('./Page');
const Customer = require('./Customer'); // Customer মডেল ইম্পোর্ট করুন
const facebookService = require('./facebookService');

const router = express.Router();

/**
 * একটি নির্দিষ্ট পেজের জন্য সব অর্ডার নিয়ে আসে।
 */
router.get('/:pageId', async (req, res) => {
    try {
        const { pageId } = req.params;

        // নিশ্চিত করুন যে এই পেজটি লগইন করা ব্যবহারকারীর
        const page = await Page.findOne({ pageId: pageId, ownerId: req.user.id });
        if (!page) {
            return res.status(403).json({ message: "You don't have permission to view orders for this page." });
        }

        // পেজের সব অর্ডার খুঁজুন এবং নতুন থেকে পুরানো অনুযায়ী সাজান
        const orders = await Order.find({ pageId: pageId }).populate('customerId', 'name').sort({ createdAt: -1 });

        res.json(orders);
    } catch (error) {
        console.error(`Error fetching orders for page ${req.params.pageId}:`, error);
        res.status(500).json({ message: 'Server error while fetching orders.' });
    }
});

/**
 * ইনবক্স থেকে একটি নতুন অর্ডার তৈরি করে।
 */
router.post('/create-from-inbox', async (req, res) => {
    try {
        const { pageId, psid, customerName, customerPhone, shippingAddress, products, totalAmount } = req.body;
        const userId = req.user._id;

        // পেজের মালিকানা ভেরিফাই করুন
        const page = await Page.findOne({ pageId: pageId, ownerId: userId }).select('+pageAccessToken');
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have permission for this page." });
        }

        // গ্রাহক খুঁজুন অথবা নতুন গ্রাহক তৈরি করুন
        let customer = await Customer.findOne({ psid: psid, pageId: pageId });
        if (!customer) {
            customer = new Customer({
                psid: psid,
                pageId: pageId,
                name: customerName,
                phone: customerPhone,
                address: shippingAddress,
            });
            await customer.save();
        } else {
            // Update existing customer info
            if(customerName) customer.name = customerName;
            if(customerPhone) customer.phone = customerPhone;
            if(shippingAddress) customer.address = shippingAddress;
            await customer.save();
        }

        // নতুন অর্ডার তৈরি করুন
        const newOrder = new Order({
            pageId,
            customerId: customer._id,
            customerInfo: { name: customerName, phone: customerPhone },
            products: products,
            shippingAddress: shippingAddress || 'N/A',
            totalAmount,
            status: 'pending', // ডিফল্ট স্ট্যাটাস
        });
        await newOrder.save();

        res.status(201).json({ message: 'Order created successfully', order: newOrder });
    } catch (error) {
        console.error("Error creating order from inbox:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

/**
 * একটি নির্দিষ্ট অর্ডারের স্ট্যাটাস আপডেট করে।
 */
router.patch('/:orderId/status', async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status } = req.body;
        const userId = req.user._id;

        const allowedStatuses = ['pending', 'completed', 'cancelled', 'shipped', 'delivered'];
        if (!status || !allowedStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid or missing status.' });
        }

        const order = await Order.findById(orderId).populate('customerId', 'psid');
        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        const page = await Page.findOne({ pageId: order.pageId, ownerId: userId }).select('+pageAccessToken');
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have permission to update this order." });
        }

        order.status = status;
        await order.save();

        // যদি স্ট্যাটাস পরিবর্তন হয় এবং গ্রাহকের PSID থাকে, তাহলে নোটিফিকেশন পাঠান
        if (order.customerId?.psid) {
            try {
                const pageAccessToken = facebookService.decryptToken(page.pageAccessToken);
                let notificationMessage = '';

                switch (status) {
                    case 'shipped':
                        notificationMessage = `সুখবর! আপনার অর্ডার (ID: #${orderId.slice(-6)}) শিপিং করা হয়েছে এবং এটি এখন আপনার ঠিকানার পথে।`;
                        break;
                    case 'delivered':
                        notificationMessage = `আপনার অর্ডার (ID: #${orderId.slice(-6)}) সফলভাবে ডেলিভারি করা হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ!`;
                        break;
                    case 'cancelled':
                        notificationMessage = `দুঃখিত, আপনার অর্ডার (ID: #${orderId.slice(-6)}) বাতিল করা হয়েছে। যেকোনো প্রয়োজনে আমাদের সাথে যোগাযোগ করুন।`;
                        break;
                }

                if (notificationMessage) {
                    await facebookService.sendTextMessage(order.customerId.psid, notificationMessage, pageAccessToken);
                }
            } catch (e) { console.error('Failed to send status update message:', e); }
        }

        res.status(200).json({ message: 'Order status updated successfully.', order });
    } catch (error) {
        console.error("Error updating order status:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});


module.exports = router;