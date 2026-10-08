import { config } from '../config.js';
import { depositCentsFor } from '../deposit.js';
import { stripe } from '../stripe.js';
import { supabaseAdmin as db, unwrap, UNIQUE_VIOLATION } from '../supabase.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Our payment row for a Checkout Session, or null if the session isn't one of ours.
async function loadPayment(session) {
  const paymentId = session.metadata?.payment_id;
  if (session.metadata?.purpose !== 'deposit' || !UUID.test(paymentId || '')) return null;
  return unwrap(db.from('payments').select('*').eq('id', paymentId).maybeSingle());
}

// The session was paid. Mark the deposit paid only if everything Stripe says
// agrees with what the database says; otherwise park it for a human.
async function handlePaid(session) {
  if (session.payment_status !== 'paid') return; // delayed method, wait for async_payment_succeeded

  const payment = await loadPayment(session);
  if (!payment) {
    console.error(`[webhook] paid session ${session.id} has no matching payment row`);
    return;
  }
  const project = await unwrap(
    db.from('projects').select('*').eq('id', payment.project_id).maybeSingle()
  );
  if (!project) {
    console.error(`[webhook] payment ${payment.id} points at a missing project`);
    await unwrap(
      db.from('payments')
        .update({ status: 'needs_review', stripe_payment_intent: session.payment_intent })
        .eq('id', payment.id)
    );
    return;
  }

  const matches =
    (payment.stripe_session_id === null || payment.stripe_session_id === session.id) &&
    session.client_reference_id === project.id &&
    session.metadata.project_id === project.id &&
    session.amount_total === payment.amount_cents &&
    session.amount_total === depositCentsFor(project) &&
    session.currency === payment.currency &&
    session.currency === project.currency;

  // A second, different payment landing on an already-paid deposit is a double charge.
  const duplicate = project.deposit_status === 'paid' && payment.status !== 'paid';
  const outcome = matches && !duplicate ? 'paid' : 'needs_review';
  if (outcome !== 'paid')
    console.error(`[webhook] payment ${payment.id} needs review (session ${session.id})`);

  await unwrap(
    db.from('payments').update({
      status: outcome,
      stripe_session_id: payment.stripe_session_id ?? session.id,
      stripe_payment_intent: session.payment_intent,
    }).eq('id', payment.id)
  );

  if (!duplicate) {
    await unwrap(
      db.from('projects').update({ deposit_status: outcome }).eq('id', project.id)
    );
  }
}

// The session expired or a delayed payment failed: close the attempt and let
// the client start over.
async function handleClosed(session, status) {
  const payment = await loadPayment(session);
  if (!payment) return;

  await unwrap(
    db.from('payments').update({ status }).eq('id', payment.id).eq('status', 'pending')
  );

  const stillPending = await unwrap(
    db.from('payments').select('id')
      .eq('project_id', payment.project_id).eq('purpose', 'deposit').eq('status', 'pending')
      .limit(1).maybeSingle()
  );
  if (!stillPending) {
    await unwrap(
      db.from('projects').update({ deposit_status: 'not_started' })
        .eq('id', payment.project_id).eq('deposit_status', 'pending')
    );
  }
}

const HANDLERS = {
  'checkout.session.completed': handlePaid,
  'checkout.session.async_payment_succeeded': handlePaid,
  'checkout.session.async_payment_failed': (session) => handleClosed(session, 'failed'),
  'checkout.session.expired': (session) => handleClosed(session, 'expired'),
};

// POST /api/stripe/webhook — must be mounted with express.raw(), before express.json().
export async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw Buffer
      req.headers['stripe-signature'],
      config.stripe.webhookSecret
    );
  } catch {
    return res.status(400).send('Invalid signature');
  }

  const handler = HANDLERS[event.type];
  if (!handler) return res.json({ received: true });

  // De-duplicate: the primary key rejects a second insert of the same event.
  // Any other database error is a 5xx so Stripe retries instead of losing the event.
  const { error: dedupError } = await db.from('stripe_events')
    .insert({ id: event.id, type: event.type });
  if (dedupError?.code === UNIQUE_VIOLATION) return res.json({ received: true, duplicate: true });
  if (dedupError) {
    console.error('[webhook] could not record event', event.id, dedupError.message);
    return res.status(500).send('Handler error');
  }

  try {
    await handler(event.data.object);
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler failed for', event.id, err?.message);
    // Roll back the de-dup row so Stripe's retry can reprocess
    await db.from('stripe_events').delete().eq('id', event.id);
    res.status(500).send('Handler error');
  }
}
