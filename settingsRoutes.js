const express = require('express');
const { protect, superAdminOnly } = require('./authMiddleware');
const SystemSetting = require('./SystemSetting');

const router = express.Router();

// GET default AI prompt (Public or protected for any authenticated user)
router.get('/default-prompt', protect, async (req, res) => {
    try {
        const setting = await SystemSetting.findOne({ key: 'DEFAULT_AI_PROMPT' });
        res.json({ prompt: setting ? setting.value : '' });
    } catch (error) {
        console.error('Error fetching default prompt:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST to update default AI prompt (Superadmin only)
router.post('/default-prompt', protect, superAdminOnly, async (req, res) => {
    try {
        const { prompt } = req.body;
        if (typeof prompt !== 'string') {
            return res.status(400).json({ message: 'Prompt is required' });
        }

        await SystemSetting.findOneAndUpdate(
            { key: 'DEFAULT_AI_PROMPT' },
            { value: prompt },
            { upsert: true, new: true }
        );

        res.json({ message: 'Default prompt updated successfully' });
    } catch (error) {
        console.error('Error updating default prompt:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
