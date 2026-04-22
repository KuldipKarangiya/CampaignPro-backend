const amqp = require('amqplib');
const { RABBITMQ_URL, QUEUES, DLQS, EXCHANGES, DELAY_QUEUES } = require('./constants');

let channel;
let connection;

const connectRabbitMQ = async () => {
  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    
    // 1. Assert Retry Router Exchange (Headers type)
    await channel.assertExchange(EXCHANGES.RETRY_ROUTER, 'headers', { durable: true });

    // 2. Assert Delay Queues (These dead-letter to the RETRY_ROUTER when their TTL expires)
    const delayLevels = [DELAY_QUEUES.LEVEL_1, DELAY_QUEUES.LEVEL_2, DELAY_QUEUES.LEVEL_3];
    for (const level of delayLevels) {
      await channel.assertQueue(level.name, {
        durable: true,
        arguments: {
          'x-message-ttl': level.ttl,
          'x-dead-letter-exchange': EXCHANGES.RETRY_ROUTER
        }
      });
    }

    // 3. Assert Dedicated DLQs
    for (const key of Object.keys(DLQS)) {
      await channel.assertQueue(DLQS[key], { durable: true });
    }

    // 4. Assert Main Queues and bind them to the Router Exchange
    for (const key of Object.keys(QUEUES)) {
      const queueName = QUEUES[key];
      await channel.assertQueue(queueName, { durable: true });
      
      // Bind main queue to router exchange based on header
      await channel.bindQueue(queueName, EXCHANGES.RETRY_ROUTER, '', {
        'x-match': 'all',
        'target-queue': queueName
      });
    }

    console.log('RabbitMQ connected and Advanced Retry Topology configured');
    return channel;
  } catch (err) {
    console.error('RabbitMQ connection error:', err);
    process.exit(1);
  }
};

const getChannel = () => {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }
  return channel;
};

module.exports = {
  connectRabbitMQ,
  getChannel
};
