const amqp = require('amqplib');
const axios = require('axios');
const csv = require('csv-parser');
const mongoose = require('mongoose');
const CsvUpload = require('../models/CsvUpload');
const { RABBITMQ_URL, QUEUES, DLQS, BATCH_SIZES, RABBITMQ, CSV_RECORDS_LIMIT, MONGO_URI } = require('../config/constants');
const { handleRetry } = require('../utils/retryHandler');

const startWorker = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGO_URI);
    }

    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    
    // Topology is now fully managed by src/config/rabbitmq.js during server startup.
    // We only assert the main queue here to be safe if started independently.
    await channel.assertQueue(QUEUES.CSV_PROCESSING, { durable: true });

    // Apply specific prefetch
    await channel.prefetch(RABBITMQ.CSV_PROCESSING.PREFETCH);

    const consumeTask = async (msg) => {
      if (msg !== null) {
        const { csvUrl, jobId } = JSON.parse(msg.content.toString());
        console.log(`Processing CSV job ${jobId} from ${csvUrl}`);

        try {
          const response = await axios({
            method: 'get',
            url: csvUrl,
            responseType: 'stream'
          });

          let batch = [];
          let recordCount = 0;
          let invalidCount = 0;
          let limitReached = false;

          response.data.pipe(csv())
            .on('data', (row) => {
              if (limitReached) return;

              recordCount++;
              if (recordCount > CSV_RECORDS_LIMIT) {
                console.warn(`Job ${jobId}: CSV record limit of ${CSV_RECORDS_LIMIT} reached. Stopping further processing.`);
                limitReached = true;
                // We can't easily "stop" the stream here without destroying it, 
                // but we can just ignore further data.
                return;
              }

              // Strip non-digits to handle formats like (123) 456-7890
              const cleanPhone = String(row.phone || '').replace(/\D/g, '');
              
              // Only process contacts with exactly 10-digit phone numbers
              if (cleanPhone.length === 10) {
                row.phone = cleanPhone; // Overwrite with clean format
                
                // Support both 'tag' and 'tags' columns
                const rawTags = row.tags || row.tag;
                if (rawTags && typeof rawTags === 'string') {
                  row.tags = rawTags.split(',').map(t => t.trim()).filter(Boolean);
                } else {
                  row.tags = [];
                }
                batch.push(row);
                
                if (batch.length >= BATCH_SIZES.CSV_PARSING) {
                  channel.sendToQueue(QUEUES.CONTACT_CREATION, Buffer.from(JSON.stringify({ batch, jobId })), { persistent: true });
                  batch = [];
                }
              } else {
                invalidCount++;
              }
            })
            .on('end', () => {
              if (batch.length > 0) {
                channel.sendToQueue(QUEUES.CONTACT_CREATION, Buffer.from(JSON.stringify({ batch, jobId })), { persistent: true });
              }
              console.log(`Finished processing CSV job ${jobId}`);
              CsvUpload.findOneAndUpdate(
                { jobId }, 
                { totalRecords: recordCount, $inc: { failCount: invalidCount } }
              ).catch(console.error);
              channel.ack(msg);
            })
            .on('error', async (err) => {
              await handleRetry(channel, QUEUES.CSV_PROCESSING, DLQS.CSV_PROCESSING, msg, err);
            });

        } catch (err) {
          await handleRetry(channel, QUEUES.CSV_PROCESSING, DLQS.CSV_PROCESSING, msg, err);
        }
      }
    };

    // Spawn consumers based on constant
    for (let i = 0; i < RABBITMQ.CSV_PROCESSING.CONSUMER_COUNT; i++) {
      channel.consume(QUEUES.CSV_PROCESSING, consumeTask);
    }
    
    console.log(`CSV Processing Worker started with ${RABBITMQ.CSV_PROCESSING.CONSUMER_COUNT} consumers and prefetch ${RABBITMQ.CSV_PROCESSING.PREFETCH}`);
  } catch (err) {
    console.error("CSV Processing Worker failed to start", err);
  }
};

// Start the worker asynchronously so it doesn't block server startup
setTimeout(startWorker, 2000); // Give RabbitMQ a moment to connect in main app
