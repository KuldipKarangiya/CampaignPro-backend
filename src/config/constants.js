require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/campaign-management-system',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  RABBITMQ_URL: process.env.RABBITMQ_URL || 'amqp://localhost',

  QUEUES: {
    CSV_PROCESSING: 'csv_processing_queue',
    CONTACT_CREATION: 'contact_creation_queue',
    CAMPAIGN_EXECUTION: 'campaign_execution_queue',
    MESSAGE_DELIVERY: 'message_delivery_queue'
  },

  DLQS: {
    CSV_PROCESSING: 'csv_processing_dlq',
    CONTACT_CREATION: 'contact_creation_dlq',
    CAMPAIGN_EXECUTION: 'campaign_execution_dlq',
    MESSAGE_DELIVERY: 'message_delivery_dlq'
  },

  EXCHANGES: {
    DLX: 'dlx_exchange',
    RETRY_ROUTER: 'retry_router_exchange'
  },

  DELAY_QUEUES: {
    LEVEL_1: { name: 'delay_5s', ttl: 5000 },
    LEVEL_2: { name: 'delay_15s', ttl: 15000 },
    LEVEL_3: { name: 'delay_45s', ttl: 45000 }
  },

  RABBITMQ: {
    CSV_PROCESSING: {
      PREFETCH: parseInt(process.env.CSV_PREFETCH) || 5,
      CONSUMER_COUNT: parseInt(process.env.CSV_CONSUMERS) || 2
    },
    CONTACT_CREATION: {
      PREFETCH: parseInt(process.env.CONTACT_PREFETCH) || 10,
      CONSUMER_COUNT: parseInt(process.env.CONTACT_CONSUMERS) || 5
    },
    CAMPAIGN_EXECUTION: {
      PREFETCH: parseInt(process.env.CAMPAIGN_PREFETCH) || 2,
      CONSUMER_COUNT: parseInt(process.env.CAMPAIGN_CONSUMERS) || 2
    },
    MESSAGE_DELIVERY: {
      PREFETCH: parseInt(process.env.DELIVERY_PREFETCH) || 50,
      CONSUMER_COUNT: parseInt(process.env.DELIVERY_CONSUMERS) || 10
    }
  },

  BATCH_SIZES: {
    CSV_PARSING: 50,
    CONTACT_INSERTION: 50,
    CAMPAIGN_EXECUTION: 100,
    MESSAGE_DELIVERY: 50
  },

  SIMULATION: {
    DELAY_MS_MIN: 50,
    DELAY_MS_MAX: 200,
    FAILURE_RATE: 0.1 // 10%
  },
  CSV_RECORDS_LIMIT: 10000
};
