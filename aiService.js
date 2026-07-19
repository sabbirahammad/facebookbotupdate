const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');

// Read keys from GROQ_API_KEYS (comma separated) or GROQ_API_KEY
const rawKeys = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY;
if (!rawKeys) {
    console.error("FATAL ERROR: GROQ_API_KEYS or GROQ_API_KEY is not defined in the environment variables.");
    console.error("Please add it to your .env file.");
    process.exit(1);
}

// Split the keys by comma and trim whitespace
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
if (apiKeys.length === 0) {
    console.error("FATAL ERROR: No valid API keys found in GROQ_API_KEYS.");
    process.exit(1);
}

// Create a Groq client for each key
const groqClients = apiKeys.map(key => new Groq({ apiKey: key }));
let currentClientIndex = 0;

// Initialize Google Generative AI
const googleApiKey = process.env.GOOGLE_API_KEY;
if (!googleApiKey) {
    console.warn("WARNING: GOOGLE_API_KEY is not defined. Image analysis will be disabled.");
}
const genAI = googleApiKey ? new GoogleGenerativeAI(googleApiKey) : null;

const DEFAULT_MODEL = "llama-3.3-70b-versatile"; // Reverted to 70b as requested

// Helper function to execute a Groq API call with automatic key rotation on rate limits
const executeWithRotation = async (apiCallFunction) => {
    let attempts = 0;
    const maxAttempts = groqClients.length;

    while (attempts < maxAttempts) {
        try {
            const currentClient = groqClients[currentClientIndex];
            return await apiCallFunction(currentClient);
        } catch (error) {
                // Check if it's a rate limit error (status 429)
                if (error.status === 429 || error.message.includes('429') || error.message.toLowerCase().includes('too many requests') || error.message.toLowerCase().includes('rate limit')) {
                    console.warn(`[Groq API] Key at index ${currentClientIndex} hit rate limit (429). Rotating to next key...`);
                    currentClientIndex = (currentClientIndex + 1) % groqClients.length;
                    attempts++;
                } else {
                    console.error("[Groq API] Non-rate-limit error:", error.response ? error.response : error);
                    throw error;
                }
        }
    }
    throw new Error("All Groq API keys are currently rate-limited.");
};

/**
 * Analyzes the user's message to determine their intent and extract relevant entities.
 * @param {string} userMessage - The message from the user.
 * @returns {Promise<{intent: string, entities: object, confidence: number}>}
 */
const getIntentAndEntities = async (userMessage) => {
    const prompt = `
    Analyze the following user message and identify the primary intent and any relevant entities.
    Your response MUST be a valid JSON object with the following structure: { "intent": "intent_name", "entities": { "key": "value" }, "confidence": 0.9 }.

    Possible intents are:
    - 'show_products': ONLY use this if the user is explicitly asking to see your catalog, collection, or want to view products (e.g., "show me t-shirts", "catalog daw"). DO NOT use 'show_products' if they are just asking a general, business, or casual question that happens to contain a product name or the word 'product' (e.g., "Ami t-shirt sell kori, apnadr product niye kivabe business korbo?"). In those cases, classify the intent as 'general_question'.
    - 'start_order': User wants to buy or order a specific product.
    - 'provide_contact_info': User is providing their name, phone number, or address.
    - 'track_order': User wants to know the status of their order.
    - 'cancel_order': User wants to cancel an order.
    - 'check_price': User is asking for the price of a product.
    - 'general_question': A general question that doesn't fit other intents.

    Possible entities are:
    - 'productName': The name of the product.
    - 'customerName': The user's full name.
    - 'phone': The user's phone number (in Bangladeshi format).
    - 'address': The user's delivery address.
    - 'orderId': The ID of an order.

    User Message: "${userMessage}"

    JSON Response:
    `;

    try {
        const chatCompletion = await executeWithRotation(async (client) => {
            return await client.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: "You are a JSON parsing assistant. Always return valid JSON only."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                model: "llama-3.1-8b-instant", // Using smaller model for much faster intent parsing (speed optimization)
                temperature: 0.1,
                response_format: { type: "json_object" }
            });
        });

        const jsonString = chatCompletion.choices[0]?.message?.content || "{}";
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Error getting intent and entities from Groq:", error);
        // Fallback to a general question if parsing fails
        return { intent: 'general_question', entities: {}, confidence: 0.5 };
    }
};

/**
 * Analyzes an image using Gemini Pro Vision and generates a descriptive text for searching.
 * @param {string} imageUrl - The URL of the image to analyze.
 * @returns {Promise<string>} A descriptive text string of the image content.
 */
const getImageDescriptionForSearch = async (imageUrl) => {
    if (!genAI) {
        throw new Error("Google AI is not initialized. Check GOOGLE_API_KEY.");
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Download the image and convert it to base64
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data, 'binary');

        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: response.headers['content-type'] || 'image/jpeg',
            },
        };

        // This prompt is crucial. It asks for keywords suitable for a database search.
        const prompt = "Analyze the main product in this image. Describe it using simple, searchable keywords. Focus on category, color, type, and material. For example: 'red cotton t-shirt' or 'black leather handbag'. Provide only the descriptive keywords as a single string.";

        const result = await model.generateContent([prompt, imagePart]);
        const aiResponse = await result.response;
        const text = aiResponse.text();
        
        // Clean up the response to be just the keywords
        return text.trim().replace(/['"]+/g, ''); // Remove quotes

    } catch (error) {
        console.error("Error getting image description from Gemini:", error);
        // In case of an error, return an empty string so the search fails gracefully.
        return "";
    }
};

/**
 * Generates a response from the AI based on conversation history and a system prompt.
 * @param {string} systemPrompt - Instructions for the AI (e.g., shop's FAQ).
 * @param {Array<{role: 'user' | 'assistant', content: string}>} history - The last few messages in the conversation.
 * @returns {Promise<string>} The AI-generated response text.
 */
const getAIResponse = async (systemPrompt, history) => {
    try {
        const finalPrompt = systemPrompt || "You are a helpful and polite assistant.";

        let formattedHistory = [];
        
        // Add system prompt first
        formattedHistory.push({
            role: "system",
            content: finalPrompt
        });

        for (let msg of history) {
            let role = msg.role === 'assistant' ? 'assistant' : 'user';
            let text = msg.content || "";
            if (!text.trim()) continue; // Skip empty messages
            
            // Groq allows same role consecutively, but merging is cleaner
            if (formattedHistory.length > 1 && formattedHistory[formattedHistory.length - 1].role === role) {
                formattedHistory[formattedHistory.length - 1].content += "\n" + text;
            } else {
                formattedHistory.push({ role, content: text });
            }
        }

        const chatCompletion = await executeWithRotation(async (client) => {
            return await client.chat.completions.create({
                messages: formattedHistory,
                model: DEFAULT_MODEL,
                temperature: 0.3,
                max_tokens: 1024 // Increased from 256 to prevent Bengali text from being cut off
            });
        });
        
        return chatCompletion.choices[0]?.message?.content || "";
    } catch (error) {
        console.error("Error getting AI response from Groq:", error);
        return "দুঃখিত, এই মুহূর্তে আমি আপনার অনুরোধটি প্রসেস করতে পারছি না।";
    }
};

/**
 * Generates 20 business-specific rules to append to the system prompt.
 */
const generateBusinessRules = async (businessType, currentPrompt) => {
    // Find the last number in the current prompt (e.g. "17. ")
    let nextNumber = 18;
    const match = currentPrompt.match(/(\d+)\.\s+/g);
    if (match && match.length > 0) {
        const lastMatch = match[match.length - 1];
        nextNumber = parseInt(lastMatch) + 1;
    }

    const prompt = `
Generate EXACTLY 20 specific, professional, and highly practical customer service and sales rules for a "${businessType}" business.
These rules will be appended to an AI assistant's system prompt to make it sound exactly like an expert human salesperson in this specific industry.
The rules MUST be written in pure Bengali (বাংলা).

CRITICAL FORMATTING INSTRUCTIONS:
1. Start numbering exactly from ${nextNumber}.
2. Format each rule exactly like this: "${nextNumber}. [Title]: [Description]"
3. Do not include any introduction, conclusion, markdown blocks, or other text. ONLY output the numbered list.
4. Each rule should be highly specific to "${businessType}" (e.g. if clothing, talk about sizes, fabrics, returns; if restaurant, talk about reservations, spicy levels, delivery time).

Output the 20 rules now:
`;

    try {
        const chatCompletion = await executeWithRotation(async (client) => {
            return await client.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
            });
        });
        
        let generatedText = chatCompletion.choices[0]?.message?.content || "";
        return generatedText.trim();
    } catch (error) {
        console.error("Error generating business rules:", error);
        throw new Error("Failed to generate business rules.");
    }
};

module.exports = { getAIResponse, getIntentAndEntities, getImageDescriptionForSearch, generateBusinessRules };

// Add product matching function
module.exports.findBestMatchingProducts = async (searchKeywords, products) => {
    if (!products || products.length === 0) return [];
    
    const productListText = products.map(p => `ID: ${p._id} | Name: ${p.name} | Desc: ${p.description || 'N/A'}`).join('\n');
    const prompt = `
A user is searching for: "${searchKeywords}".
Here is my list of available products:
${productListText}

Which of these products match the search query? Consider synonyms, related items, and different languages (e.g. English vs Bengali).
Return a JSON array of the matching product IDs (e.g. ["123", "456"]). If none match, return [].
Respond ONLY with a valid JSON array. Do not include any other text, markdown, or explanation.
`;

    try {
        const chatCompletion = await executeWithRotation(async (client) => {
            return await client.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.1,
            });
        });
        
        let responseText = chatCompletion.choices[0]?.message?.content || "[]";
        responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const matchedIds = JSON.parse(responseText);
        
        return products.filter(p => matchedIds.includes(p._id.toString()));
    } catch (e) {
        console.error("AI matching error:", e);
        // Fallback to simple keyword match
        const searchTerms = searchKeywords.toLowerCase().split(/[\s,]+/);
        return products.filter(p => {
            const text = `${p.name} ${p.description}`.toLowerCase();
            return searchTerms.some(term => term.length > 3 && text.includes(term));
        });
    }
};