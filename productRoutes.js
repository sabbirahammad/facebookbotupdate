const express = require('express');
const router = express.Router();
const productController = require('./productController');
const { protect } = require('./authMiddleware');

const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

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