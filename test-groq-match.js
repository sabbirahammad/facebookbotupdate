require('dotenv').config();
const mongoose = require('mongoose');
const aiService = require('./aiService');

async function testMatch() {
    const searchKeywords = "yellow cotton t-shirt";
    
    const products = [
        { _id: new mongoose.Types.ObjectId(), name: "Mens Blue Shirt", description: "Blue cotton shirt for men" },
        { _id: new mongoose.Types.ObjectId(), name: "Yellow T-Shirt Kids", description: "Bright yellow tshirt for children" },
        { _id: new mongoose.Types.ObjectId(), name: "Black Jeans", description: "Black denim" }
    ];
    
    console.log("Testing with products:");
    console.log(products.map(p => `${p._id} - ${p.name}`).join('\n'));
    
    const matched = await aiService.findBestMatchingProducts(searchKeywords, products);
    console.log("Matched Products:", matched);
}

testMatch();
