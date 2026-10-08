// End-to-end tests of the HTTP API against an in-memory Supabase and a fake
// Stripe Checkout. Webhook signatures are real (Stripe's own signing code).
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.APP_URL = 'http://localhost:8080';

// --- in-memory Supabase ----------------------------------------------------

const UNIQUE = {
  payments: [
    (r) => r.stripe_session_id && `session:${r.stripe_session_id}`,
    (r) => r.purpose === 'deposit' && r.status === 'pending' && `pending:${r.project_id}`,
  ],
  stripe_events: [(r) => `id:${r.id}`],
};
let tables;
let failNext; // { table, op } -> the next matching call returns an error

class Query {
  constructor(table) { this.table = table; this.filters = []; this.op = 'select'; }
  select() { return this; }
  insert(row) { this.op = 'insert'; this.row = row; return this; }
  update(patch) { this.op = 'update'; this.patch = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }

  run() {
    if (failNext && failNext.table === this.table && failNext.op === this.op) {
      failNext = null;
      return { data: null, error: { code: 'XX000', message: 'boom' } };
    }
    const rows = tables[this.table];
    const violates = (candidate, self) =>
      (UNIQUE[this.table] || []).some((key) => {
        const k = key(candidate);
        return k && rows.some((r) => r !== self && key(r) === k);
      });

    if (this.op === 'insert') {
      const row = {
        id: randomUUID(), status: 'pending', purpose: 'deposit', stripe_session_id: null,
        created_at: new Date().toISOString(), ...this.row,
      };
      if (violates(row)) return { data: null, error: { code: '23505', message: 'duplicate' } };
      rows.push(row);
      return { data: this.one ? row : [row], error: null };
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'update') {
      for (const r of matched) {
        if (violates({ ...r, ...this.patch }, r))
          return { data: null, error: { code: '23505', message: 'duplicate' } };
        Object.assign(r, this.patch);
      }
      return { data: null, error: null };
    }
    if (this.op === 'delete') {
      tables[this.table] = rows.filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    return { data: this.one ? matched.at(-1) ?? null : matched, error: null };
  }
}

const fakeDb = { from: (table) => new Query(table) };

// --- fake Stripe -----------------------------------------------------------

const realStripe = new Stripe('sk_test_x');
let sessions; // id -> session
let createCalls;

const fakeStripe = {
  webhooks: realStripe.webhooks,
  checkout: {
    sessions: {
      async create(params, { idempotencyKey }) {
        createCalls.push({ params, idempotencyKey });
        const existing = Object.values(sessions).find((s) => s.idempotencyKey === idempotencyKey);
        if (existing) return existing;
        const id = `cs_test_${Object.keys(sessions).length + 1}`;
        sessions[id] = {
          id, idempotencyKey, status: 'open', url: `https://checkout.stripe.test/${id}`,
          amount_total: params.line_items[0].price_data.unit_amount,
          currency: params.line_items[0].price_data.currency,
          client_reference_id: params.client_reference_id,
          metadata: params.metadata,
          payment_status: 'unpaid',
          payment_intent: null,
        };
        return sessions[id];
      },
      async retrieve(id) { return sessions[id]; },
      async expire(id) { sessions[id].status = 'expired'; return sessions[id]; },
    },
  },
};

// --- wiring ----------------------------------------------------------------

const src = (p) => new URL(`../src/${p}`, import.meta.url).href;

mock.module(src('supabase.js'), {
  namedExports: {
    supabaseAdmin: fakeDb,
    UNIQUE_VIOLATION: '23505',
    unwrap: async (q) => { const { data, error } = await q; if (error) throw error; return data; },
  },
});
mock.module(src('stripe.js'), { namedExports: { stripe: fakeStripe } });
// Token "user:<uuid>" authenticates as that user. Real JWT checks are in auth.test.js.
mock.module(src('auth.js'), {
  namedExports: {
    requireUser(req, res, next) {
      const m = /^Bearer user:(.+)$/.exec(req.headers.authorization || '');
      if (!m) return res.status(401).json({ error: 'Missing token' });
      req.user = { id: m[1], email: 'client@example.com' };
      next();
    },
  },
});

const ALICE = randomUUID();
const MALLORY = randomUUID();
let server, base, project;

before(async () => {
  const { default: app } = await import(src('app.js'));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  project = {
    id: randomUUID(), client_id: ALICE, name: 'Shop', estimate_cents: 1_200_000,
    deposit_percent: 25, currency: 'cad', deposit_status: 'not_started',
  };
  tables = { projects: [project], payments: [], stripe_events: [] };
  sessions = {};
  createCalls = [];
  failNext = null;
  mock.method(console, 'error', () => {});
});

const pay = (user, body) =>
  fetch(`${base}/api/payments/deposit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user && { authorization: `Bearer user:${user}` }) },
    body: JSON.stringify(body),
  });

function sendEvent(type, object, { id = `evt_${randomUUID()}`, secret = 'whsec_test' } = {}) {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object } });
  const signature = realStripe.webhooks.generateTestHeaderString({ payload, secret });
  return fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

async function startCheckout() {
  const res = await pay(ALICE, { projectId: project.id });
  assert.equal(res.status, 200);
  return Object.values(sessions).at(-1);
}
const paid = (session, extra = {}) => ({
  ...session, status: 'complete', payment_status: 'paid', payment_intent: 'pi_1', ...extra,
});

// --- creating the checkout session ----------------------------------------

test('rejects unauthenticated requests', async () => {
  const res = await pay(null, { projectId: project.id });
  assert.equal(res.status, 401);
  assert.equal(createCalls.length, 0);
});

test("404 for a project the user doesn't own", async () => {
  const res = await pay(MALLORY, { projectId: project.id });
  assert.equal(res.status, 404);
  assert.equal(createCalls.length, 0);
});

test('amount comes from the database, whatever the client sends', async () => {
  const res = await pay(ALICE, { projectId: project.id, amount: 1, amount_cents: 1, userId: MALLORY });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()), ['url']);

  const { params, idempotencyKey } = createCalls[0];
  assert.equal(params.line_items[0].price_data.unit_amount, 300_000);
  assert.equal(params.line_items[0].price_data.currency, 'cad');
  assert.equal(params.metadata.user_id, ALICE);
  assert.equal(idempotencyKey, `deposit-${tables.payments[0].id}`);
  assert.equal(tables.payments[0].user_id, ALICE);
  assert.equal(project.deposit_status, 'pending');
});

test('no estimate yet: nothing to pay', async () => {
  project.estimate_cents = null;
  assert.equal((await pay(ALICE, { projectId: project.id })).status, 409);
  assert.equal(createCalls.length, 0);
});

test('already paid deposit cannot be paid again', async () => {
  project.deposit_status = 'paid';
  assert.equal((await pay(ALICE, { projectId: project.id })).status, 409);
  assert.equal(createCalls.length, 0);
});

test('malformed projectId is a 400', async () => {
  assert.equal((await pay(ALICE, { projectId: 'x' })).status, 400);
  assert.equal((await pay(ALICE, {})).status, 400);
});

test('paying twice returns the same checkout URL', async () => {
  const a = await (await pay(ALICE, { projectId: project.id })).json();
  const b = await (await pay(ALICE, { projectId: project.id })).json();
  assert.equal(a.url, b.url);
  assert.equal(Object.keys(sessions).length, 1);
  assert.equal(tables.payments.length, 1);
});

test('concurrent double-click creates one session', async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, () => pay(ALICE, { projectId: project.id }))
  );
  const urls = new Set();
  for (const res of results) {
    assert.equal(res.status, 200);
    urls.add((await res.json()).url);
  }
  assert.equal(urls.size, 1);
  assert.equal(Object.keys(sessions).length, 1);
  assert.equal(tables.payments.filter((p) => p.status === 'pending').length, 1);
});

test('changed estimate expires the old session and charges the new amount', async () => {
  const old = await startCheckout();
  project.estimate_cents = 2_000_000;

  const res = await pay(ALICE, { projectId: project.id });
  assert.equal(res.status, 200);
  assert.equal(old.status, 'expired');
  assert.equal(createCalls.at(-1).params.line_items[0].price_data.unit_amount, 500_000);
  assert.deepEqual(tables.payments.map((p) => p.status), ['expired', 'pending']);
});

test('expired session is replaced with a new one', async () => {
  const old = await startCheckout();
  old.status = 'expired';
  const { url } = await (await pay(ALICE, { projectId: project.id })).json();
  assert.notEqual(url, old.url);
  assert.deepEqual(tables.payments.map((p) => p.status), ['expired', 'pending']);
});

test('status endpoint reports state to the owner only', async () => {
  const get = (user) =>
    fetch(`${base}/api/payments/deposit/${project.id}`, { headers: { authorization: `Bearer user:${user}` } });
  assert.equal((await get(MALLORY)).status, 404);
  assert.deepEqual(await (await get(ALICE)).json(), {
    projectId: project.id, depositStatus: 'not_started', depositCents: 300_000, currency: 'cad',
  });
});

// --- webhook ---------------------------------------------------------------

test('bad signature is rejected and changes nothing', async () => {
  const session = await startCheckout();
  const res = await sendEvent('checkout.session.completed', paid(session), { secret: 'whsec_wrong' });
  assert.equal(res.status, 400);
  assert.equal(project.deposit_status, 'pending');
  assert.equal(tables.stripe_events.length, 0);
});

test('verified paid session marks the deposit paid', async () => {
  const session = await startCheckout();
  const res = await sendEvent('checkout.session.completed', paid(session));
  assert.equal(res.status, 200);
  assert.equal(project.deposit_status, 'paid');
  assert.equal(tables.payments[0].status, 'paid');
  assert.equal(tables.payments[0].stripe_payment_intent, 'pi_1');
});

test('replayed event is not processed twice', async () => {
  const session = await startCheckout();
  await sendEvent('checkout.session.completed', paid(session), { id: 'evt_1' });
  project.deposit_status = 'refunded'; // would be overwritten if reprocessed
  const res = await sendEvent('checkout.session.completed', paid(session), { id: 'evt_1' });
  assert.deepEqual(await res.json(), { received: true, duplicate: true });
  assert.equal(project.deposit_status, 'refunded');
});

test('amount mismatch goes to needs_review, not paid', async () => {
  const session = await startCheckout();
  await sendEvent('checkout.session.completed', paid(session, { amount_total: 100 }));
  assert.equal(project.deposit_status, 'needs_review');
  assert.equal(tables.payments[0].status, 'needs_review');
});

test('estimate changed after checkout started goes to needs_review', async () => {
  const session = await startCheckout();
  project.estimate_cents = 2_000_000;
  await sendEvent('checkout.session.completed', paid(session));
  assert.equal(project.deposit_status, 'needs_review');
});

test('wrong currency or project reference goes to needs_review', async () => {
  let session = await startCheckout();
  await sendEvent('checkout.session.completed', paid(session, { currency: 'usd' }));
  assert.equal(project.deposit_status, 'needs_review');

  project.deposit_status = 'not_started';
  tables.payments = [];
  session = await startCheckout();
  await sendEvent('checkout.session.completed', paid(session, { client_reference_id: randomUUID() }));
  assert.equal(project.deposit_status, 'needs_review');
});

test('completed but unpaid (delayed method) waits for async success', async () => {
  const session = await startCheckout();
  session.status = 'complete'; // what Stripe reports once the customer has submitted
  await sendEvent('checkout.session.completed', { ...session, payment_status: 'unpaid' });
  assert.equal(project.deposit_status, 'pending');
  assert.equal((await pay(ALICE, { projectId: project.id })).status, 409); // no second charge meanwhile

  await sendEvent('checkout.session.async_payment_succeeded', paid(session));
  assert.equal(project.deposit_status, 'paid');
});

test('second paid session on a paid deposit is flagged, deposit stays paid', async () => {
  const first = await startCheckout();
  await sendEvent('checkout.session.completed', paid(first));

  const stray = { ...first, id: 'cs_test_stray', idempotencyKey: 'other' };
  const { data: row } = await fakeDb.from('payments').insert({
    project_id: project.id, user_id: ALICE, amount_cents: 300_000, currency: 'cad',
    stripe_session_id: stray.id,
  }).select().single();
  stray.metadata = { ...first.metadata, payment_id: row.id };

  await sendEvent('checkout.session.completed', paid(stray, { payment_intent: 'pi_2' }));
  assert.equal(project.deposit_status, 'paid');
  assert.equal(row.status, 'needs_review');
});

test('expired session reopens the deposit', async () => {
  const session = await startCheckout();
  await sendEvent('checkout.session.expired', { ...session, status: 'expired' });
  assert.equal(tables.payments[0].status, 'expired');
  assert.equal(project.deposit_status, 'not_started');
});

test('late expiry event cannot undo a paid deposit', async () => {
  const session = await startCheckout();
  await sendEvent('checkout.session.completed', paid(session));
  await sendEvent('checkout.session.expired', { ...session, status: 'expired' });
  assert.equal(tables.payments[0].status, 'paid');
  assert.equal(project.deposit_status, 'paid');
});

test('handler failure returns 500 and lets the retry succeed', async () => {
  const session = await startCheckout();
  failNext = { table: 'projects', op: 'update' };
  const first = await sendEvent('checkout.session.completed', paid(session), { id: 'evt_retry' });
  assert.equal(first.status, 500);
  assert.equal(tables.stripe_events.length, 0);

  const retry = await sendEvent('checkout.session.completed', paid(session), { id: 'evt_retry' });
  assert.equal(retry.status, 200);
  assert.equal(project.deposit_status, 'paid');
});

test('database outage while de-duplicating is a 500, not a silent drop', async () => {
  const session = await startCheckout();
  failNext = { table: 'stripe_events', op: 'insert' };
  const res = await sendEvent('checkout.session.completed', paid(session));
  assert.equal(res.status, 500);
  assert.equal(project.deposit_status, 'pending');
});

test("sessions that aren't ours are acknowledged and ignored", async () => {
  const res = await sendEvent('checkout.session.completed', {
    id: 'cs_other', payment_status: 'paid', metadata: {}, amount_total: 5, currency: 'cad',
  });
  assert.equal(res.status, 200);
  assert.equal(project.deposit_status, 'not_started');
});
