const express = require('express');
const { createCampaign, startCampaign, getCampaigns, getCampaignDetails } = require('../controllers/campaignController');
const router = express.Router();

router.post('/', createCampaign);
router.post('/:id/start', startCampaign);
router.get('/', getCampaigns);
router.get('/:id', getCampaignDetails);

module.exports = router;
