const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    pageId: {
        type: String,
        required: true,
        index: true,
    },
    customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer',
        required: true,
    },
    products: [{
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
        },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
    }],
    totalAmount: {
        type: Number,
        required: true,
    },
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
        default: 'pending',
    },
    shippingAddress: {
        type: String,
        required: true,
    },
    customerInfo: {
        name: String,
        phone: String,
    },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);