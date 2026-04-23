const express = require('express');
const { uploadCSV, getContacts, getUploads } = require('../controllers/contactController');
const router = express.Router();

router.post('/upload', uploadCSV);
router.get('/uploads', getUploads);
router.get('/', getContacts);

module.exports = router;
