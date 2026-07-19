const QuickReply = require('./QuickReply');

// Get all quick replies for a user
exports.getQuickReplies = async (req, res) => {
  try {
    const replies = await QuickReply.find({ userId: req.user.id });
    res.json(replies);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching quick replies', error });
  }
};

// Create a new quick reply
exports.createQuickReply = async (req, res) => {
  try {
    const { title, text } = req.body;
    const newReply = new QuickReply({
      title,
      text,
      userId: req.user.id,
    });
    await newReply.save();
    res.status(201).json(newReply);
  } catch (error) {
    res.status(500).json({ message: 'Error creating quick reply', error });
  }
};

// Update a quick reply
exports.updateQuickReply = async (req, res) => {
  try {
    const { title, text } = req.body;
    const updatedReply = await QuickReply.findByIdAndUpdate(
      req.params.id,
      { title, text },
      { new: true }
    );
    res.json(updatedReply);
  } catch (error) {
    res.status(500).json({ message: 'Error updating quick reply', error });
  }
};

// Delete a quick reply
exports.deleteQuickReply = async (req, res) => {
  try {
    await QuickReply.findByIdAndDelete(req.params.id);
    res.json({ message: 'Quick reply deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting quick reply', error });
  }
};