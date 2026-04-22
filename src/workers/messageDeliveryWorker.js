const amqp = require('amqplib');
const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const Message = require('../models/Message');
const { RABBITMQ_URL, QUEUES, DLQS, MONGO_URI, SIMULATION, RABBITMQ } = require('../config/constants');
const { handleRetry } = require('../utils/retryHandler');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const startWorker = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGO_URI);
    }

    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    
    await channel.assertQueue(QUEUES.MESSAGE_DELIVERY, { durable: true });

    // Apply specific prefetch
    await channel.prefetch(RABBITMQ.MESSAGE_DELIVERY.PREFETCH);

    const consumeTask = async (msg) => {
      if (msg !== null) {
        const { campaignId, messageIds } = JSON.parse(msg.content.toString());
        console.log(`Simulating delivery for ${messageIds.length} messages in campaign ${campaignId}`);

        try {
          await Message.updateMany({ _id: { $in: messageIds } }, { $set: { status: 'Processing' } });

          const delay = Math.floor(Math.random() * (SIMULATION.DELAY_MS_MAX - SIMULATION.DELAY_MS_MIN + 1)) + SIMULATION.DELAY_MS_MIN;
          await sleep(delay);

          const sentIds = [];
          const failedIds = [];

          for (const msgId of messageIds) {
            if (Math.random() < SIMULATION.FAILURE_RATE) {
              failedIds.push(msgId);
            } else {
              sentIds.push(msgId);
            }
          }

          const bulkOps = [];
          if (sentIds.length > 0) {
            bulkOps.push({
              updateMany: {
                filter: { _id: { $in: sentIds } },
                update: { $set: { status: 'Sent' } }
              }
            });
          }
          if (failedIds.length > 0) {
            bulkOps.push({
              updateMany: {
                filter: { _id: { $in: failedIds } },
                update: { $set: { status: 'Failed' } }
              }
            });
          }

          if (bulkOps.length > 0) {
            await Message.bulkWrite(bulkOps);
          }

          const updatedCampaign = await Campaign.findByIdAndUpdate(
            campaignId,
            {
              $inc: {
                sentCount: sentIds.length,
                failedCount: failedIds.length,
                pendingCount: -messageIds.length
              }
            },
            { new: true }
          );

          if (updatedCampaign && updatedCampaign.pendingCount <= 0) {
            // Use findOneAndUpdate to atomically set status to 'Completed' 
            // only if it's not already set. This prevents race conditions between parallel delivery workers.
            const completedCampaign = await Campaign.findOneAndUpdate(
              { _id: campaignId, status: { $ne: 'Completed' } },
              { $set: { status: 'Completed' } }
            );
            
            if (completedCampaign) {
              console.log(`Campaign ${campaignId} has completed successfully.`);
            }
          }

          console.log(`Delivery simulated: ${sentIds.length} sent, ${failedIds.length} failed.`);
          channel.ack(msg);

        } catch (err) {
          await handleRetry(channel, QUEUES.MESSAGE_DELIVERY, DLQS.MESSAGE_DELIVERY, msg, err);
        }
      }
    };

    // Spawn consumers based on constant
    for (let i = 0; i < RABBITMQ.MESSAGE_DELIVERY.CONSUMER_COUNT; i++) {
      channel.consume(QUEUES.MESSAGE_DELIVERY, consumeTask);
    }

    console.log(`Message Delivery Worker started with ${RABBITMQ.MESSAGE_DELIVERY.CONSUMER_COUNT} consumers and prefetch ${RABBITMQ.MESSAGE_DELIVERY.PREFETCH}`);
  } catch (err) {
    console.error("Message Delivery Worker failed to start", err);
  }
};

setTimeout(startWorker, 2000);
