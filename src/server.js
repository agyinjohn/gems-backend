require('dotenv').config();
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const routes = require('./routes');
const errorHandler = require('./middleware/errorHandler');

connectDB();

const app = express();
const PORT = process.env.PORT || 5000;

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server / curl
    const allowed = [
      'http://localhost:3000',
      process.env.FRONTEND_URL?.replace(/\/$/, ''), // strip trailing slash
    ].filter(Boolean);
    // also allow any vercel.app preview deployment
    if (allowed.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', system: 'GEMS', version: '1.0.0', timestamp: new Date() });
});

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found.` });
});

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const { startBillingCron } = require('./utils/billingCron');
  startBillingCron();
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║         GEMS — Backend         ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Server running on port ${PORT}         ║`);
  console.log(`║  Environment: ${process.env.NODE_ENV || 'development'}            ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
