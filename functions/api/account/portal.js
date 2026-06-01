// POST /api/account/portal — open the Stripe Customer Portal (update card, view invoices).
// Returns { url } to redirect to. Stripe hosts it securely so we never touch card data.
import { ok, fail } from '../../_lib/respond.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';

export async function onRequestPost(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { env } = context;
  const { customer } = auth;
  if (!customer.stripe_customer_id) return fail(400, 'no_billing', 'No billing account yet — start a plan first.');

  try {
    const session = await stripe(env, 'POST', 'billing_portal/sessions', {
      customer: customer.stripe_customer_id,
      return_url: `${env.APP_BASE_URL || ''}/app/`,
    });
    return ok({ url: session.url });
  } catch (e) {
    return fail(502, 'portal_failed', String(e?.message || e).slice(0, 160));
  }
}
