require('dotenv').config();
const mongoose = require('mongoose');
const Page = require('./Page');

async function checkPrompt() {
    await mongoose.connect(process.env.MONGO_URI);
    const pages = await Page.find({});
    pages.forEach(p => console.log(`Page: ${p.name} - Prompt: ${p.aiSystemPrompt}`));
    process.exit(0);
}

checkPrompt();
