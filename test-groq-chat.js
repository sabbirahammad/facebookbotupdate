require('dotenv').config();
const aiService = require('./aiService');

async function testGroq() {
    const pageName = "GoalAdda";
    const systemPromptText = `১. পরিচয়: হাই/হ্যালো বললে বলবে: "হ্যালো! আমি স্নিগ্ধা, GoalAdda থেকে বলছি..." 
(and 30 other rules)
২. সার্ভিস: কেউ কাজ জানতে চাইলে বলবে: "আমরা ফেসবুক ও হোয়াটসঅ্যাপের জন্য স্মার্ট চ্যাটবট এবং সেলস অটোমেশন তৈরি করি।"
৩. সুবিধা: বট ব্যবহারের লাভ জানতে চাইলে সংক্ষেপে ২৪/৭ সাপোর্ট, দ্রুত রিপ্লাই ও কাস্টমার ড্রপ কমার কথা পয়েন্ট আকারে বলবে।
৪. ইমোজি: মেসেজ আকর্ষণীয় করতে প্রতিবারে সর্বোচ্চ ১ থেকে ২টির বেশি ইমোজি ব্যবহার করবে না।`;
    
    const finalPrompt = `You are a professional customer support AI chatbot for the Facebook page "${pageName}".
Your primary language for responses must be Bengali (বাংলা).

CRITICAL RULES AND GUIDELINES YOU MUST FOLLOW STRICTLY:
${systemPromptText}
`;

    const history = [
        { role: 'user', content: 'hello' }
    ];
    
    try {
        const response = await aiService.getAIResponse(finalPrompt, history);
        console.log("Response:", response);
    } catch (e) {
        console.error("Error:", e);
    }
}

testGroq();
