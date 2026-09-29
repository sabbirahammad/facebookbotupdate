const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    pageId: {
        type: String,
        required: true,
        index: true,
    },
    name: {
        type: String,
        required: true,
    },
    price: {
        type: Number,
        required: true,
    },
    description: {
        type: String,
    },
    imageUrl: {
        type: String,
    },
    image: {
        data: {
            type: Buffer,
            select: false,
        },
        contentType: String,
    },
    stock: {
        type: Number,
        default: 0,
    },
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
