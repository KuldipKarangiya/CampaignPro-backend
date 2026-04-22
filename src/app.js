const express = require('express');
const cors = require('cors');
const { apiLimiter } = require('./config/redis');
const contactRoutes = require('./routes/contactRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');

const swaggerDocument = YAML.load(path.join(__dirname, '../swagger.yaml'));

const app = express();

// Middlewares
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3001',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// Apply rate limiting globally to /api
app.use('/api/', apiLimiter);

// Routes
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Something went wrong!", data: null });
});

module.exports = app;
