// The one place the deposit amount is calculated. Used when creating the
// Checkout Session and again when the webhook verifies what was paid.
// Returns integer cents, or null while the project has no estimate yet.
export function depositCentsFor(project) {
  if (!Number.isInteger(project.estimate_cents) || project.estimate_cents <= 0) return null;
  return Math.round((project.estimate_cents * project.deposit_percent) / 100);
}
