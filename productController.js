const Product = require('./Product');
const Page = require('./Page');

const getPublicBaseUrl = (req) => (process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const getStoredImage = (file) => ({
    data: file.buffer,
    contentType: file.mimetype || 'application/octet-stream',
});

const toProductResponse = (product) => {
    const response = product.toObject();
    delete response.image;
    return response;
};

/**
 * একটি নির্দিষ্ট পেজের জন্য একটি নতুন প্রোডাক্ট তৈরি করে।
 */
exports.createProduct = async (req, res) => {
    try {
        const { pageId } = req.params;
        const { name, price, description, stock } = req.body;
        const userId = req.user._id;
        
        const imageUrl = req.body.imageUrl || '';

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
            image: req.file ? getStoredImage(req.file) : undefined,
            stock,
        });

        await newProduct.save();
        if (req.file) {
            newProduct.imageUrl = `${getPublicBaseUrl(req)}/uploads/products/${newProduct._id}`;
            await newProduct.save();
        }
        res.status(201).json(toProductResponse(newProduct));
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
            updateData.image = getStoredImage(req.file);
            updateData.imageUrl = `${getPublicBaseUrl(req)}/uploads/products/${productId}`;
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
        res.status(200).json(toProductResponse(updatedProduct));
    } catch (error) {
        console.error("Error updating product:", error);
        res.status(500).json({ message: "Internal server error." });
    }
};

exports.getProductImage = async (req, res) => {
    try {
        const product = await Product.findById(req.params.productId).select('+image.data image.contentType');
        if (!product?.image?.data) {
            return res.sendStatus(404);
        }

        res.set({
            'Content-Type': product.image.contentType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
        });
        return res.send(product.image.data);
    } catch (error) {
        console.error('Error serving product image:', error);
        return res.sendStatus(404);
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
