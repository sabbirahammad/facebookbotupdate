require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

async function listModels() {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        // The SDK might not have a direct listModels, we can try fetching gemini-1.5-flash
        // Or we can use REST API
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_API_KEY}`);
        const data = await response.json();
        console.log(data.models.map(m => m.name));
    } catch (e) {
        console.error(e);
    }
}
listModels();
