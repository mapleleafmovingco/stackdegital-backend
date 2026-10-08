// Env loading + validation. Imported first by everything that reads config,
// so a missing secret stops the process at boot instead of at the first payment.
import 'dotenv/config';

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'APP_URL',
];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing environment variable(s): ${missing.join(', ')}. See .env.example.`);
}

const stripTrailingSlash = (url) => url.replace(/\/+$/, '');

const supabaseUrl = stripTrailingSlash(process.env.SUPABASE_URL);
const appUrl = stripTrailingSlash(process.env.APP_URL);

for (const [name, value] of [['SUPABASE_URL', supabaseUrl], ['APP_URL', appUrl]]) {
  if (!URL.canParse(value)) throw new Error(`${name} is not a valid URL`);
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  appUrl,
  // Number of reverse proxies in front of the app (0 = none). Needed for correct
  // client IPs in the rate limiter when deployed behind a load balancer.
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  supabase: {
    url: supabaseUrl,
    secretKey: process.env.SUPABASE_SECRET_KEY,
    jwksUrl: process.env.SUPABASE_JWKS_URL || `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    jwtIssuer: `${supabaseUrl}/auth/v1`,
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
};
