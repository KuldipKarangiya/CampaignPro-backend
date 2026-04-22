const express = require('express');
const { uploadCSV, getContacts } = require('../controllers/contactController');
const router = express.Router();

router.post('/upload', uploadCSV);
router.get('/', getContacts);

module.exports = router;
