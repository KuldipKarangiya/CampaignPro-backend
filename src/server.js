const app = require('./app');
const { PORT } = require('./config/constants');
const connectDB = require('./config/db');
const { connectRabbitMQ } = require('./config/rabbitmq');

// Load workers
require('./workers/csvProcessingWorker');
require('./workers/contactCreationWorker');
require('./workers/campaignExecutionWorker');
require('./workers/messageDeliveryWorker');

const startServer = async () => {
  try {
    await connectDB();
    await connectRabbitMQ();

    app.listen(PORT, () => {
      console.log(`\n🚀 Server is running on port ${PORT}`);
      console.log(`📜 Swagger documentation: http://localhost:${PORT}/api-docs`);
      console.log(`🐰 RabbitMQ Management UI: http://localhost:15673 (guest/guest)`);
      console.log(`💾 Redis Management UI: http://localhost:8081`);
      console.log(`🔗 Redis connection: ${process.env.REDIS_URL || 'redis://127.0.0.1:6377'}\n`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
