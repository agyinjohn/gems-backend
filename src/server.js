require('dotenv').config();
require('express-async-errors');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const routes = require('./routes');
const errorHandler = require('./middleware/errorHandler');
const sanitize = require('./middleware/sanitize');
const limits = require('./middleware/rateLimits');

const app = express();
// Trust the hosting proxy so req.ip is the real client address (audit log and
// rate limits both rely on it). TRUST_PROXY is how many proxies sit in front of
// the app — 1 for a single load balancer, 2 behind a CDN as well. `true` (the
// default, as before) trusts the whole X-Forwarded-For chain, which works but
// lets a caller invent an address; set the number to close that.
const trustProxy = process.env.TRUST_PROXY;
app.set('trust proxy', trustProxy === undefined || trustProxy === '' ? true : (/^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true'));
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowed = ['http://localhost:3000', process.env.FRONTEND_URL?.replace(/\/$/, '')].filter(Boolean);
      if (allowed.includes(origin) || origin.endsWith('.vercel.app')) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  },
});
app.set('io', io);

// Live support chat. Nobody gets in without a valid session, and what a
// socket may listen to is decided here, not by what it asks for.
require('./sockets/chatSocket')(io);

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
app.use('/api', limits.api);

// Paystack webhook — raw body required for signature verification
const { handlePaystackWebhook } = require('./controllers/webhookController');
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), handlePaystackWebhook);

app.use(express.json({ limit: '10mb' }));
app.use(sanitize);
app.use(morgan('dev'));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', system: 'GEMS', version: '1.0.0', timestamp: new Date() });
});

// ── SWAGGER DOCS ─────────────────────────────────────────────────────────────
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger/spec');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'GEMS ERP API Docs',
}));
app.get('/api-docs.json', (req, res) => res.json(swaggerSpec));

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found.` });
});

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── START ─────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  await connectDB();
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
