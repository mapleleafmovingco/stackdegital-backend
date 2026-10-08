// Verify the Supabase access token against the project's JWKS.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';

const JWKS = createRemoteJWKSet(new URL(config.supabase.jwksUrl));

export async function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  let payload;
  try {
    ({ payload } = await jwtVerify(token, JWKS, {
      issuer: config.supabase.jwtIssuer,
      audience: 'authenticated',
    }));
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (!payload.sub) return res.status(401).json({ error: 'Invalid or expired token' });

  // The only identity the rest of the app may use. Never a userId from the body.
  req.user = { id: payload.sub, email: payload.email };
  next();
}
