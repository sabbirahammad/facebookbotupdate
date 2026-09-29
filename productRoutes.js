const express = require('express');
const router = express.Router();
const productController = require('./productController');
const { protect } = require('./authMiddleware');

const multer = require('multer');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

// সমস্ত রাউট authMiddleware দ্বারা সুরক্ষিত থাকবে
router.use(protect);

// একটি পেজের জন্য একটি নতুন প্রোডাক্ট তৈরি করুন
router.post('/:pageId', upload.single('image'), productController.createProduct);

// একটি পেজের সমস্ত প্রোডাক্ট পান
router.get('/:pageId', productController.getProductsByPage);

// একটি নির্দিষ্ট প্রোডাক্ট আপডেট করুন
router.patch('/:productId', upload.single('image'), productController.updateProduct);

// একটি নির্দিষ্ট প্রোডাক্ট ডিলিট করুন
router.delete('/:productId', productController.deleteProduct);

module.exports = router;
