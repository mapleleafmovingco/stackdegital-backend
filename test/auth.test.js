// requireUser against a local JWKS endpoint with real signed tokens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

let jwksServer, requireUser, goodKey, otherKey;
const ISSUER = 'https://example.supabase.co/auth/v1';

before(async () => {
  goodKey = await generateKeyPair('ES256');
  otherKey = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(goodKey.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };

  jwksServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  }).listen(0);

  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_JWKS_URL = `http://127.0.0.1:${jwksServer.address().port}/jwks.json`;
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.APP_URL = 'http://localhost:8080';
  ({ requireUser } = await import('../src/auth.js'));
});
after(() => jwksServer.close());

function token({ key = goodKey, issuer = ISSUER, audience = 'authenticated', exp = '5m', sub = 'user-1' } = {}) {
  const jwt = new SignJWT({ email: 'a@b.co' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(issuer).setAudience(audience).setExpirationTime(exp);
  if (sub) jwt.setSubject(sub);
  return jwt.sign(key.privateKey);
}

async function run(authorization) {
  const req = { headers: authorization ? { authorization } : {} };
  const out = { nextCalled: false };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await requireUser(req, res, () => { out.nextCalled = true; });
  return { ...out, user: req.user };
}

test('valid token sets req.user from the verified claims', async () => {
  const r = await run(`Bearer ${await token()}`);
  assert.equal(r.nextCalled, true);
  assert.deepEqual(r.user, { id: 'user-1', email: 'a@b.co' });
});

test('missing token', async () => {
  const r = await run();
  assert.equal(r.status, 401);
  assert.equal(r.nextCalled, false);
});

for (const [name, opts] of [
  ['signed by another key', { key: 'other' }],
  ['wrong issuer', { issuer: 'https://evil.example/auth/v1' }],
  ['wrong audience (anon)', { audience: 'anon' }],
  ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ['no subject', { sub: null }],
]) {
  test(`rejects token: ${name}`, async () => {
    if (opts.key === 'other') opts.key = otherKey;
    const r = await run(`Bearer ${await token(opts)}`);
    assert.equal(r.status, 401);
    assert.equal(r.nextCalled, false);
    assert.equal(r.user, undefined);
  });
}

test('rejects garbage', async () => {
  assert.equal((await run('Bearer not.a.jwt')).status, 401);
});
