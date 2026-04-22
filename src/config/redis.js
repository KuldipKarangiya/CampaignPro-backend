const { createClient } = require('redis');
const { REDIS_URL } = require('./constants');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;

const redisClient = createClient({
  url: REDIS_URL
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.on('connect', () => console.log('Redis connected successfully'));

redisClient.connect().catch(console.error);

// Global rate limiter middleware
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  store: new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }),
  message: { message: "Too many requests, please try again later.", data: null }
});

module.exports = {
  redisClient,
  apiLimiter
};
