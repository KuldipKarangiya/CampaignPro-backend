const amqp = require('amqplib');
const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const { RABBITMQ_URL, QUEUES, DLQS, MONGO_URI, BATCH_SIZES, RABBITMQ } = require('../config/constants');
const { handleRetry } = require('../utils/retryHandler');

const startWorker = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGO_URI);
    }

    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    
    await channel.assertQueue(QUEUES.CAMPAIGN_EXECUTION, { durable: true });

    // Apply specific prefetch
    await channel.prefetch(RABBITMQ.CAMPAIGN_EXECUTION.PREFETCH);

    const consumeTask = async (msg) => {
      if (msg !== null) {
        const { campaignId } = JSON.parse(msg.content.toString());
        console.log(`Executing campaign ${campaignId}`);

        try {
          const campaign = await Campaign.findById(campaignId);
          if (!campaign) {
            console.error(`Campaign not found: ${campaignId}`);
            channel.ack(msg);
            return;
          }

          const filter = campaign.audienceFilter || {};
          
          // Get total count first to initialize counters correctly and avoid race conditions with delivery workers
          const totalContacts = await Contact.countDocuments(filter);
          
          campaign.totalContacts = totalContacts;
          campaign.pendingCount = totalContacts;
          await campaign.save();

          console.log(`Starting execution for campaign ${campaignId}. Total contacts: ${totalContacts}`);

          const cursor = Contact.find(filter).cursor();
          const template = campaign.template || "";
          let messagesBatch = [];
          let processedInThisWorker = 0;

          for await (const contact of cursor) {
            // High-performance personalization replacement
            const personalizedContent = template
              .replace(/{name}/g, contact.name || "Customer")
              .replace(/{email}/g, contact.email || "");

            messagesBatch.push({
              campaignId: campaign._id,
              contactId: contact._id,
              content: personalizedContent,
              status: 'Queued'
            });
            processedInThisWorker++;

            if (messagesBatch.length >= BATCH_SIZES.CAMPAIGN_EXECUTION) {
              const insertedMessages = await Message.insertMany(messagesBatch);
              const messageIds = insertedMessages.map(m => m._id);
              channel.sendToQueue(QUEUES.MESSAGE_DELIVERY, Buffer.from(JSON.stringify({ campaignId, messageIds })), { persistent: true });
              messagesBatch = [];
            }
          }

          if (messagesBatch.length > 0) {
            const insertedMessages = await Message.insertMany(messagesBatch);
            const messageIds = insertedMessages.map(m => m._id);
            channel.sendToQueue(QUEUES.MESSAGE_DELIVERY, Buffer.from(JSON.stringify({ campaignId, messageIds })), { persistent: true });
          }

          console.log(`Campaign ${campaignId} execution initialization finished.`);

          console.log(`Campaign ${campaignId} execution initialized. Total contacts: ${totalContacts}`);
          channel.ack(msg);

        } catch (err) {
          console.error(`Campaign execution failed for ${campaignId}:`, err);
          try {
            await Campaign.findByIdAndUpdate(campaignId, { status: 'Failed' });
          } catch(e) {}
          await handleRetry(channel, QUEUES.CAMPAIGN_EXECUTION, DLQS.CAMPAIGN_EXECUTION, msg, err);
        }
      }
    };

    // Spawn consumers based on constant
    for (let i = 0; i < RABBITMQ.CAMPAIGN_EXECUTION.CONSUMER_COUNT; i++) {
      channel.consume(QUEUES.CAMPAIGN_EXECUTION, consumeTask);
    }

    console.log(`Campaign Execution Worker started with ${RABBITMQ.CAMPAIGN_EXECUTION.CONSUMER_COUNT} consumers and prefetch ${RABBITMQ.CAMPAIGN_EXECUTION.PREFETCH}`);
  } catch (err) {
    console.error("Campaign Execution Worker failed to start", err);
  }
};

setTimeout(startWorker, 2000);
