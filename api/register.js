/**
 * Vercel Serverless Function: /api/register
 * Handles event registration requests without needing a persistent server.
 */

const { processRegistration } = require('../lib/registerHandler');

module.exports = async function handler(req, res) {
  // Set CORS headers
  const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, X-Idempotency-Key'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({
      success: false,
      message: 'Method Not Allowed. Use POST.'
    });
    return;
  }

  try {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
    const result = await processRegistration(req.body, clientIp);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Serverless API Error]', err);
    res.status(500).json({
      success: false,
      message: 'An unexpected internal error occurred. Please try again shortly.'
    });
  }
};
