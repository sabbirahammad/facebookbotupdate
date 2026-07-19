require('dotenv').config();
const Groq = require('groq-sdk');
const rawKeys = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY;
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const client = new Groq({ apiKey: apiKeys[0] });

async function testGroqDirect() {
    try {
        const chatCompletion = await client.chat.completions.create({
            messages: [{ role: "user", content: "hello" }],
            model: "llama-3.1-8b-instant",
        });
        console.log("Success:", chatCompletion.choices[0].message.content);
    } catch (e) {
        console.error("GROQ API ERROR DETAILS:");
        if (e.response) {
            console.error(JSON.stringify(e.response, null, 2));
        } else if (e.error) {
            console.error(JSON.stringify(e.error, null, 2));
        } else {
            console.error(e);
        }
    }
}

testGroqDirect();
