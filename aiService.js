const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');

// Read keys from GROQ_API_KEYS (comma separated) or GROQ_API_KEY
const rawKeys = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY;
if (!rawKeys) {
    console.warn("WARNING: GROQ_API_KEYS or GROQ_API_KEY is not defined in the environment variables.");
}

// Split the keys by comma and trim whitespace
const apiKeys = rawKeys ? rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0) : [];
const groqClients = apiKeys.map(key => new Groq({ apiKey: key }));
let currentClientIndex = 0;

// Initialize Google Generative AI
const googleApiKey = process.env.GOOGLE_API_KEY;
if (!googleApiKey) {
    console.warn("WARNING: GOOGLE_API_KEY is not defined.");
}
const genAI = googleApiKey ? new GoogleGenerativeAI(googleApiKey) : null;

// Helper function to execute a Groq API call with automatic key rotation on rate limits
const executeWithRotation = async (apiCallFunction) => {
    if (groqClients.length === 0) {
        throw new Error("No valid Groq API client available.");
    }
    let attempts = 0;
    const maxAttempts = groqClients.length;

    while (attempts < maxAttempts) {
        try {
            const currentClient = groqClients[currentClientIndex];
            return await apiCallFunction(currentClient);
        } catch (error) {
            if (error.status === 429 || error.message?.includes('429') || error.message?.toLowerCase().includes('rate limit')) {
                console.warn(`[Groq API] Key at index ${currentClientIndex} hit rate limit (429). Rotating to next key...`);
                currentClientIndex = (currentClientIndex + 1) % groqClients.length;
                attempts++;
            } else {
                throw error;
            }
        }
    }
    throw new Error("All Groq API keys are currently rate-limited.");
};

/**
 * Call Groq trying multiple supported models sequentially
 */
const callGroqWithFallback = async (messages, extraConfig = {}) => {
    const modelsToTry = [
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "qwen/qwen3.8-27b",
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant"
    ];

    let lastError = null;
    for (const modelName of modelsToTry) {
        try {
            const chatCompletion = await executeWithRotation(async (client) => {
                return await client.chat.completions.create({
                    messages,
                    model: modelName,
                    ...extraConfig
                });
            });
            const content = chatCompletion?.choices?.[0]?.message?.content;
            if (content) return content;
        } catch (err) {
            lastError = err;
            console.warn(`[Groq Model "${modelName}" failed]: ${err.message}`);
        }
    }
    throw lastError || new Error("All Groq models failed");
};

/**
 * Fallback AI execution using Google Gemini
 */
const callGeminiFallback = async (systemPrompt, userPrompt) => {
    if (!genAI) throw new Error("Google Generative AI is not configured.");
    const geminiModels = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-3.5-flash"];
    
    const promptText = systemPrompt ? `System: ${systemPrompt}\n\nUser: ${userPrompt}` : userPrompt;

    for (const modelName of geminiModels) {
        try {
            console.log(`[Gemini Fallback] Attempting with model: ${modelName}`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(promptText);
            const response = await result.response;
            const text = response.text();
            if (text) return text;
        } catch (err) {
            console.warn(`[Gemini Model "${modelName}" failed]: ${err.message}`);
        }
    }
    throw new Error("All Gemini fallback models failed.");
};

/**
 * Analyzes the user's message to determine their intent and extract relevant entities.
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
        let jsonString = "";
        try {
            jsonString = await callGroqWithFallback([
                { role: "system", content: "You are a JSON parsing assistant. Always return valid JSON only." },
                { role: "user", content: prompt }
            ], { response_format: { type: "json_object" } });
        } catch (groqErr) {
            console.warn("[getIntentAndEntities] Groq failed, falling back to Gemini...");
            jsonString = await callGeminiFallback("You are a JSON parsing assistant. Always return valid JSON only.", prompt);
            jsonString = jsonString.replace(/```json/gi, '').replace(/```/g, '').trim();
        }

        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Error getting intent and entities:", error);
        return { intent: 'general_question', entities: {}, confidence: 0.5 };
    }
};

/**
 * Analyzes an image using Gemini Pro Vision and generates a descriptive text for searching.
 */
const getImageDescriptionForSearch = async (imageUrl) => {
    if (!genAI) {
        throw new Error("Google AI is not initialized. Check GOOGLE_API_KEY.");
    }

    const geminiModels = ["gemini-3.6-flash", "gemini-2.5-flash"];

    for (const modelName of geminiModels) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data, 'binary');

            const imagePart = {
                inlineData: {
                    data: imageBuffer.toString('base64'),
                    mimeType: response.headers['content-type'] || 'image/jpeg',
                },
            };

            const prompt = "Analyze the main product in this image. Describe it using simple, searchable keywords. Focus on category, color, type, and material. For example: 'red cotton t-shirt' or 'black leather handbag'. Provide only the descriptive keywords as a single string.";

            const result = await model.generateContent([prompt, imagePart]);
            const aiResponse = await result.response;
            const text = aiResponse.text();
            if (text) return text.trim().replace(/['"]+/g, '');
        } catch (error) {
            console.warn(`[getImageDescriptionForSearch] Gemini model "${modelName}" failed:`, error.message);
        }
    }
    return "";
};

const VISUAL_MATCH_MIN_CONFIDENCE = Number(process.env.VISUAL_MATCH_MIN_CONFIDENCE || 0.85);
const MAX_VISUAL_MATCH_CANDIDATES = 20;
const MAX_VISUAL_MATCH_IMAGE_BYTES = 8 * 1024 * 1024;

const getImagePart = async (imageUrl) => {
    const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        maxContentLength: MAX_VISUAL_MATCH_IMAGE_BYTES,
        maxBodyLength: MAX_VISUAL_MATCH_IMAGE_BYTES,
        timeout: 15000,
    });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
        throw new Error(`Expected an image but received ${contentType}.`);
    }
    return { inlineData: { data: Buffer.from(response.data).toString('base64'), mimeType: contentType } };
};

const parseVisualMatches = (responseText, candidateIds, minimumConfidence = VISUAL_MATCH_MIN_CONFIDENCE) => {
    const cleaned = String(responseText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return [];

    let parsed;
    try {
        parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    } catch (error) {
        return [];
    }
    const allowedIds = new Set(candidateIds.map(String));
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    return matches
        .map(match => ({ id: String(match.id || ''), confidence: Number(match.confidence) }))
        .filter(match => allowedIds.has(match.id) && Number.isFinite(match.confidence) && match.confidence >= minimumConfidence)
        .sort((a, b) => b.confidence - a.confidence);
};

/**
 * Matches the actual reference and catalog images, not generic product labels.
 */
const findExactVisualMatches = async (imageUrl, products) => {
    if (!genAI || !imageUrl || !Array.isArray(products)) return [];
    const candidates = products.filter(product => product && product._id && product.imageUrl).slice(0, MAX_VISUAL_MATCH_CANDIDATES);
    if (candidates.length === 0) return [];

    try {
        const sourceImage = await getImagePart(imageUrl);
        const imageResults = await Promise.allSettled(candidates.map(async product => ({
            product,
            image: await getImagePart(product.imageUrl),
        })));
        const imageCandidates = imageResults
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value);
        if (imageCandidates.length === 0) return [];

        const candidateList = imageCandidates.map(({ product }, index) => (
            `${index + 1}. ID: ${product._id}; Name: ${product.name || 'Unnamed product'}; Description: ${product.description || 'None'}`
        )).join('\n');
        const prompt = `The FIRST image is the customer's reference. The remaining images are catalog products in this exact order:\n${candidateList}\n\nReturn only JSON: {"matches":[{"id":"catalog product id","confidence":0.0}]}. Include a product only when it is the exact same catalog item or the exact same set/design. Compare distinctive print, colors, borders, pieces, and layout. Do not match merely because category, color family, or material is similar. If no exact product exists, return {"matches":[]}.`;

        for (const modelName of ["gemini-3.6-flash", "gemini-2.5-flash"]) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await model.generateContent([prompt, sourceImage, ...imageCandidates.map(candidate => candidate.image)]);
                const response = await result.response;
                const matches = parseVisualMatches(response.text(), imageCandidates.map(candidate => candidate.product._id));
                return matches.map(match => imageCandidates.find(candidate => candidate.product._id.toString() === match.id)?.product).filter(Boolean);
            } catch (error) {
                console.warn(`[findExactVisualMatches] Gemini model "${modelName}" failed:`, error.message);
            }
        }
    } catch (error) {
        console.warn('[findExactVisualMatches] Could not load one or more images:', error.message);
    }
    return [];
};

/**
 * Generates a response from the AI based on conversation history and a system prompt.
 */
const getAIResponse = async (systemPrompt, history) => {
    try {
        const finalPrompt = systemPrompt || "You are a helpful and polite assistant.";

        let formattedHistory = [];
        formattedHistory.push({ role: "system", content: finalPrompt });

        for (let msg of history) {
            let role = msg.role === 'assistant' ? 'assistant' : 'user';
            let text = msg.content || "";
            if (!text.trim()) continue;
            
            if (formattedHistory.length > 1 && formattedHistory[formattedHistory.length - 1].role === role) {
                formattedHistory[formattedHistory.length - 1].content += "\n" + text;
            } else {
                formattedHistory.push({ role, content: text });
            }
        }

        try {
            return await callGroqWithFallback(formattedHistory, { temperature: 0.3, max_tokens: 1024 });
        } catch (groqErr) {
            console.warn("[getAIResponse] Groq failed, falling back to Gemini...");
            const lastUserMsg = history.filter(h => h.role === 'user').pop()?.content || "";
            return await callGeminiFallback(finalPrompt, lastUserMsg);
        }
    } catch (error) {
        console.error("Error getting AI response:", error);
        return "দুঃখিত, এই মুহূর্তে আমি আপনার অনুরোধটি প্রসেস করতে পারছি না।";
    }
};

/**
 * Generates 20 business-specific rules to append to the system prompt.
 */
const generateBusinessRules = async (businessType, currentPrompt) => {
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
        try {
            const text = await callGroqWithFallback([{ role: "user", content: prompt }], { temperature: 0.7 });
            return text.trim();
        } catch (groqErr) {
            console.warn("[generateBusinessRules] Groq failed, falling back to Gemini...");
            const text = await callGeminiFallback(null, prompt);
            return text.trim();
        }
    } catch (error) {
        console.error("Error generating business rules:", error);
        throw new Error("Failed to generate business rules.");
    }
};

/**
 * Add product matching function
 */
const findBestMatchingProducts = async (searchKeywords, products) => {
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
        let responseText = "";
        try {
            responseText = await callGroqWithFallback([{ role: "user", content: prompt }], { temperature: 0.1 });
        } catch (groqErr) {
            console.warn("[findBestMatchingProducts] Groq failed, falling back to Gemini...");
            responseText = await callGeminiFallback(null, prompt);
        }
        
        responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const matchedIds = JSON.parse(responseText);
        
        return products.filter(p => matchedIds.includes(p._id.toString()));
    } catch (e) {
        console.error("AI matching error:", e);
        const searchTerms = searchKeywords.toLowerCase().split(/[\s,]+/);
        return products.filter(p => {
            const text = `${p.name} ${p.description}`.toLowerCase();
            return searchTerms.some(term => term.length > 3 && text.includes(term));
        });
    }
};

module.exports = {
    getAIResponse,
    getIntentAndEntities,
    getImageDescriptionForSearch,
    findExactVisualMatches,
    parseVisualMatches,
    generateBusinessRules,
    findBestMatchingProducts
};
