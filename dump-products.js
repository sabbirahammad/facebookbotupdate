require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('./Product');

async function dumpProducts() {
    await mongoose.connect(process.env.MONGO_URI);
    const products = await Product.find({});
    console.log("Products in DB:");
    products.forEach(p => console.log(`- Page: ${p.pageId} | Name: ${p.name} | Desc: ${p.description}`));
    process.exit(0);
}

dumpProducts();
