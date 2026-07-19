const Product = require('./Product');
const Page = require('./Page');

/**
 * একটি নির্দিষ্ট পেজের জন্য একটি নতুন প্রোডাক্ট তৈরি করে।
 */
exports.createProduct = async (req, res) => {
    try {
        const { pageId } = req.params;
        const { name, price, description, stock } = req.body;
        const userId = req.user._id;
        
        let imageUrl = req.body.imageUrl || '';
        if (req.file) {
            imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        }

        // পেজের মালিকানা যাচাই করুন
        const page = await Page.findOne({ pageId: pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't own this page." });
        }

        const newProduct = new Product({
            pageId,
            name,
            price,
            description,
            imageUrl,
            stock,
        });

        await newProduct.save();
        res.status(201).json(newProduct);
    } catch (error) {
        console.error("Error creating product:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * একটি নির্দিষ্ট পেজের সমস্ত প্রোডাক্ট নিয়ে আসে।
 */
exports.getProductsByPage = async (req, res) => {
    try {
        const { pageId } = req.params;
        const userId = req.user._id;

        // পেজের মালিকানা যাচাই করুন
        const page = await Page.findOne({ pageId: pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't own this page." });
        }

        const products = await Product.find({ pageId: pageId }).sort({ createdAt: -1 });
        res.status(200).json(products);
    } catch (error) {
        console.error("Error fetching products:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * একটি নির্দিষ্ট প্রোডাক্ট আপডেট করে।
 */
exports.updateProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        const updateData = req.body;
        const userId = req.user._id;

        if (req.file) {
            updateData.imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        }

        const product = await Product.findById(productId);
        if (!product) {
            return res.status(404).json({ message: 'Product not found.' });
        }

        // পেজের মালিকানা যাচাই করুন
        const page = await Page.findOne({ pageId: product.pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have permission to update this product." });
        }

        const updatedProduct = await Product.findByIdAndUpdate(productId, updateData, { new: true });
        res.status(200).json(updatedProduct);
    } catch (error) {
        console.error("Error updating product:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

/**
 * একটি নির্দিষ্ট প্রোডাক্ট ডিলিট করে।
 */
exports.deleteProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        const userId = req.user._id;

        const product = await Product.findById(productId);
        if (!product) {
            return res.status(404).json({ message: 'Product not found.' });
        }

        // পেজের মালিকানা যাচাই করুন
        const page = await Page.findOne({ pageId: product.pageId, ownerId: userId });
        if (!page) {
            return res.status(403).json({ message: "Forbidden: You don't have permission to delete this product." });
        }

        await Product.findByIdAndDelete(productId);
        res.status(200).json({ message: 'Product deleted successfully.' });
    } catch (error) {
        console.error("Error deleting product:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};