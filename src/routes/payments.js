import { Router } from 'express';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { depositCentsFor } from '../deposit.js';
import { supabaseAdmin as db, unwrap, UNIQUE_VIOLATION } from '../supabase.js';
import { stripe } from '../stripe.js';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Checkout Sessions expire this long after the payment row was created (Stripe
// minimum is 30 min). Derived from the row, not from "now", so a retried
// request sends Stripe identical parameters under the same idempotency key.
const SESSION_TTL_SECONDS = 40 * 60;
// A pending row that never got a session after this long is a crashed attempt.
const ORPHAN_AFTER_MS = 2 * 60 * 1000;

// Ownership check. Callers answer 404 for "missing" and "not yours" alike, so
// project IDs can't be probed.
function loadOwnedProject(projectId, userId) {
  return unwrap(
    db.from('projects').select('*').eq('id', projectId).eq('client_id', userId).maybeSingle()
  );
}

function findPendingPayment(projectId) {
  return unwrap(
    db.from('payments').select('*')
      .eq('project_id', projectId).eq('purpose', 'deposit').eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
  );
}

function closePayment(paymentId, status) {
  return unwrap(
    db.from('payments').update({ status }).eq('id', paymentId).eq('status', 'pending')
  );
}

const PROCESSING = { status: 409, error: 'A payment for this deposit is already being processed' };

// Returns the pending payment row to check out with, a ready checkout URL, or
// a rejection. Closes pending rows that can no longer be used.
async function resolvePendingPayment(project, depositCents) {
  const payment = await findPendingPayment(project.id);
  if (!payment) return {};

  const quoteChanged =
    payment.amount_cents !== depositCents || payment.currency !== project.currency;

  if (!payment.stripe_session_id) {
    const orphaned = Date.now() - new Date(payment.created_at).getTime() > ORPHAN_AFTER_MS;
    if (!quoteChanged && !orphaned) return { payment };
    await closePayment(payment.id, 'failed');
    return {};
  }

  const session = await stripe.checkout.sessions.retrieve(payment.stripe_session_id);
  if (session.status === 'complete') return { reject: PROCESSING };
  if (session.status === 'open') {
    if (!quoteChanged) return { url: session.url };
    // The estimate changed since this session was created: it must not be payable.
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch {
      return { reject: PROCESSING };
    }
  }
  await closePayment(payment.id, 'expired');
  return {};
}

// POST /api/payments/deposit  { projectId }
// The client sends only the project ID. The amount comes from the database.
router.post('/deposit', requireUser, async (req, res) => {
  const { projectId } = req.body || {};
  if (typeof projectId !== 'string' || !UUID.test(projectId))
    return res.status(400).json({ error: 'projectId required' });

  const project = await loadOwnedProject(projectId, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (project.deposit_status === 'paid')
    return res.status(409).json({ error: 'Deposit already paid' });
  if (project.deposit_status === 'needs_review' || project.deposit_status === 'refunded')
    return res.status(409).json({ error: 'This deposit is under review. Please contact us.' });

  const depositCents = depositCentsFor(project);
  if (depositCents === null)
    return res.status(409).json({ error: 'This project does not have an estimate yet' });

  // Reuse the open attempt if there is one, otherwise record a new one. The
  // unique index on pending deposits makes a concurrent double-click lose the
  // insert, after which it picks up the winner's row.
  let payment;
  for (let attempt = 0; attempt < 2 && !payment; attempt++) {
    const pending = await resolvePendingPayment(project, depositCents);
    if (pending.reject) return res.status(pending.reject.status).json({ error: pending.reject.error });
    if (pending.url) return res.json({ url: pending.url });
    if (pending.payment) {
      payment = pending.payment;
      break;
    }

    const { data, error } = await db.from('payments').insert({
      project_id: project.id,
      user_id: req.user.id,
      amount_cents: depositCents,
      currency: project.currency,
    }).select().single();
    if (error && error.code !== UNIQUE_VIOLATION) throw error;
    payment = data;
  }
  if (!payment) return res.status(409).json({ error: PROCESSING.error });

  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: payment.currency,
            unit_amount: payment.amount_cents,
            product_data: { name: `Deposit: ${project.name}` },
          },
        }],
        client_reference_id: project.id,
        ...(req.user.email && { customer_email: req.user.email }),
        metadata: {
          project_id: project.id,
          user_id: req.user.id,
          payment_id: payment.id,
          purpose: 'deposit',
        },
        expires_at: Math.floor(new Date(payment.created_at).getTime() / 1000) + SESSION_TTL_SECONDS,
        success_url: `${config.appUrl}/pay?checkout=return&project=${project.id}`,
        cancel_url: `${config.appUrl}/pay?checkout=cancelled&project=${project.id}`,
      },
      { idempotencyKey: `deposit-${payment.id}` }
    );
  } catch (err) {
    // Two requests raced on the same payment row; the other one is creating the session.
    if (err?.type === 'StripeIdempotencyError')
      return res.status(409).json({ error: PROCESSING.error });
    throw err;
  }

  await unwrap(db.from('payments').update({ stripe_session_id: session.id }).eq('id', payment.id));
  await unwrap(
    db.from('projects').update({ deposit_status: 'pending' })
      .eq('id', project.id).eq('deposit_status', 'not_started')
  );

  // Only the URL goes back
  res.json({ url: session.url });
});

// GET /api/payments/deposit/:projectId
// What the checkout return page polls. It reports what the webhook recorded;
// it never marks anything as paid.
router.get('/deposit/:projectId', requireUser, async (req, res) => {
  const { projectId } = req.params;
  if (!UUID.test(projectId)) return res.status(404).json({ error: 'Project not found' });

  const project = await loadOwnedProject(projectId, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  res.json({
    projectId: project.id,
    depositStatus: project.deposit_status,
    depositCents: depositCentsFor(project),
    currency: project.currency,
  });
});

export default router;
