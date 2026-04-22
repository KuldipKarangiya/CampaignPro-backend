const Campaign = require('../models/Campaign');
const { getChannel } = require('../config/rabbitmq');
const { QUEUES } = require('../config/constants');

const createCampaign = async (req, res) => {
  try {
    const { name, template, audienceFilter } = req.body;

    if (!name || !template) {
      return res.status(400).json({ message: "Name and template are required", data: null });
    }

    const campaign = new Campaign({
      name,
      template,
      audienceFilter: audienceFilter || {}
    });

    await campaign.save();

    return res.status(201).json({
      message: "Campaign created successfully",
      data: { campaignId: campaign._id }
    });
  } catch (error) {
    console.error("Create campaign error:", error);
    return res.status(500).json({ message: "Internal server error", data: null });
  }
};

const startCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const { all_selected, tags, created_after, created_before } = req.body;

    // Build the audience filter based on the payload
    let campaignFilter = {};
    if (all_selected === true) {
      campaignFilter = {}; // Match all
    } else {
      // Build specific filters
      if (tags && Array.isArray(tags) && tags.length > 0) {
        campaignFilter.tags = { $in: tags }; 
      }
      
      if (created_after || created_before) {
        campaignFilter.createdAt = {};
        if (created_after) campaignFilter.createdAt.$gte = new Date(created_after);
        if (created_before) campaignFilter.createdAt.$lte = new Date(created_before);
      }
    }

    // Use findOneAndUpdate with status filter to ensure atomicity.
    // This prevents two simultaneous requests from both starting the campaign.
    const campaign = await Campaign.findOneAndUpdate(
      { 
        _id: id, 
        status: { $in: ['Draft', 'Failed'] } 
      },
      { 
        $set: { 
          status: 'Running',
          audienceFilter: campaignFilter
        } 
      },
      { new: true }
    );

    if (!campaign) {
      // If we can't find it with that status, it's either missing or already running
      return res.status(400).json({ 
        message: "Campaign not found or is already in progress/completed", 
        data: null 
      });
    }

    // Push to campaign execution queue
    const channel = getChannel();
    channel.sendToQueue(QUEUES.CAMPAIGN_EXECUTION, Buffer.from(JSON.stringify({ campaignId: campaign._id })), { persistent: true });

    return res.status(200).json({
      message: "Campaign started successfully",
      data: null
    });
  } catch (error) {
    console.error("Start campaign error:", error);
    return res.status(500).json({ message: "Internal server error", data: null });
  }
};

const getCampaigns = async (req, res) => {
  try {
    let { cursor, limit } = req.query;
    limit = parseInt(limit) || 20;

    let query = {};

    if (cursor) {
      const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('ascii'));
      query.$or = [
        { createdAt: { $lt: new Date(decodedCursor.createdAt) } },
        { 
          createdAt: new Date(decodedCursor.createdAt), 
          _id: { $lt: decodedCursor._id } 
        }
      ];
    }

    const campaigns = await Campaign.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);

    let nextCursor = null;
    if (campaigns.length === limit) {
      const lastCampaign = campaigns[campaigns.length - 1];
      const cursorData = {
        createdAt: lastCampaign.createdAt.toISOString(),
        _id: lastCampaign._id.toString()
      };
      nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
    }

    return res.status(200).json({
      message: "Campaigns retrieved",
      data: {
        campaigns,
        nextCursor,
        limit
      }
    });
  } catch (error) {
    console.error("Get campaigns error:", error);
    return res.status(500).json({ message: "Internal server error", data: null });
  }
};

const getCampaignDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    // For dashboard polling, we rely on the pre-calculated counters on the campaign document.
    const campaign = await Campaign.findById(id);
    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found", data: null });
    }

    return res.status(200).json({
      message: "Campaign details retrieved",
      data: {
        campaignId: campaign._id,
        name: campaign.name,
        status: campaign.status,
        totalMessages: campaign.totalContacts,
        sentCount: campaign.sentCount,
        failedCount: campaign.failedCount,
        pendingCount: campaign.pendingCount
      }
    });
  } catch (error) {
    console.error("Get campaign details error:", error);
    return res.status(500).json({ message: "Internal server error", data: null });
  }
};

module.exports = {
  createCampaign,
  startCampaign,
  getCampaigns,
  getCampaignDetails
};
