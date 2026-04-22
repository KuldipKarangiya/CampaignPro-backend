const amqp = require('amqplib');
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const { RABBITMQ_URL, QUEUES, DLQS, MONGO_URI, RABBITMQ } = require('../config/constants');
const { handleRetry } = require('../utils/retryHandler');

const startWorker = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGO_URI);
    }

    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    
    await channel.assertQueue(QUEUES.CONTACT_CREATION, { durable: true });

    // Apply specific prefetch
    await channel.prefetch(RABBITMQ.CONTACT_CREATION.PREFETCH);

    const consumeTask = async (msg) => {
      if (msg !== null) {
        const { batch, jobId } = JSON.parse(msg.content.toString());
        console.log(`Inserting batch of ${batch.length} for job ${jobId}`);

        try {
          await Contact.insertMany(batch, { ordered: false });
          console.log(`Successfully inserted batch for job ${jobId}`);
          channel.ack(msg);
        } catch (err) {
          if (err.code === 11000) {
            console.log(`Batch inserted with some skipped duplicates for job ${jobId}`);
            channel.ack(msg);
          } else {
            await handleRetry(channel, QUEUES.CONTACT_CREATION, DLQS.CONTACT_CREATION, msg, err);
          }
        }
      }
    };

    // Spawn consumers based on constant
    for (let i = 0; i < RABBITMQ.CONTACT_CREATION.CONSUMER_COUNT; i++) {
      channel.consume(QUEUES.CONTACT_CREATION, consumeTask);
    }

    console.log(`Contact Creation Worker started with ${RABBITMQ.CONTACT_CREATION.CONSUMER_COUNT} consumers and prefetch ${RABBITMQ.CONTACT_CREATION.PREFETCH}`);
  } catch (err) {
    console.error("Contact Creation Worker failed to start", err);
  }
};

setTimeout(startWorker, 2000);
