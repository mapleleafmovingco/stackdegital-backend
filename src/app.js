// App setup. Middleware order matters.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import paymentRoutes from './routes/payments.js';
import { stripeWebhook } from './routes/webhook.js';

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use(helmet());

app.get('/healthz', (req, res) => res.json({ ok: true }));

// 1) Webhook FIRST, with raw body, no CORS needed (Stripe calls it server-to-server)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// 2) Everything else uses JSON + CORS restricted to the frontend
app.use(cors({ origin: config.appUrl }));
app.use(express.json({ limit: '10kb' }));

// Status polling shares this limiter, so it is looser than one click per few seconds.
app.use(
  '/api/payments',
  rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }),
  paymentRoutes
);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Never echo internals (Stripe/Supabase error text) back to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[error]', req.method, req.path, err?.message);
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : 'Bad request' });
});

export default app;
