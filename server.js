/**
 * IMARTICUS DATATHON 2026 - Express Server
 * Serves static website files and provides the hidden /api/register endpoint.
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const { processRegistration } = require('./lib/registerHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable reverse-proxy trust for accurate IP resolution behind CDNs/proxies
app.set('trust proxy', 1);

// Configure CORS
const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigin === '*' || origin === allowedOrigin) {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS policy'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Idempotency-Key']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '32kb' }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    event: 'IMARTICUS DATATHON 2026',
    timestamp: new Date().toISOString()
  });
});

// Registration Endpoint
app.post('/api/register', async (req, res) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
  try {
    const result = await processRegistration(req.body, clientIp);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[API Server Error]', err);
    res.status(500).json({
      success: false,
      message: 'An unexpected internal error occurred. Please try again shortly.'
    });
  }
});

// Serve frontend static assets from project root
app.use(express.static(__dirname));

// Fallback route to serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Express server if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`  IMARTICUS DATATHON 2026 Server Running`);
    console.log(`  Local URL:   http://localhost:${PORT}`);
    console.log(`  API Route:   http://localhost:${PORT}/api/register`);
    console.log(`====================================================`);
  });
}

module.exports = app;
