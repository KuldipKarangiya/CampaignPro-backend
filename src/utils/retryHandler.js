const { EXCHANGES, DELAY_QUEUES, DLQS } = require('../config/constants');

const handleRetry = async (channel, targetQueue, specificDlq, msg, error) => {
  try {
    let payload = JSON.parse(msg.content.toString());
    payload.retryCount = (payload.retryCount || 0) + 1;
    payload.error = error.message || error.toString();

    if (payload.retryCount <= 3) {
      let delayQueueName;
      if (payload.retryCount === 1) delayQueueName = DELAY_QUEUES.LEVEL_1.name;
      else if (payload.retryCount === 2) delayQueueName = DELAY_QUEUES.LEVEL_2.name;
      else delayQueueName = DELAY_QUEUES.LEVEL_3.name;

      console.log(`[Retry ${payload.retryCount}/3] Message failed in ${targetQueue}. Delaying via ${delayQueueName}. Error: ${payload.error}`);

      // Publish to the delay queue directly. 
      // Add the header 'target-queue' so the router exchange knows where to send it after TTL.
      channel.sendToQueue(delayQueueName, Buffer.from(JSON.stringify(payload)), {
        persistent: true,
        headers: {
          'target-queue': targetQueue
        }
      });
      
      // Ack the original message so it doesn't get requeued immediately
      channel.ack(msg);
    } else {
      console.error(`[DLQ] Message permanently failed after 3 retries in ${targetQueue}. Moving to ${specificDlq}.`);
      
      // Publish to the specific DLQ
      channel.sendToQueue(specificDlq, Buffer.from(JSON.stringify(payload)), { persistent: true });
      channel.ack(msg);
    }
  } catch (err) {
    console.error('Failed to process retry logic:', err);
    // Fallback: standard nack
    channel.nack(msg, false, false);
  }
};

module.exports = { handleRetry };
