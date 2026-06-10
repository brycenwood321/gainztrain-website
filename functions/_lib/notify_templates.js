// Notification templates — one entry per customer-facing event. Each is a PURE function
// (data) => { subject, html, sms } so it's unit-testable with no network and renders every dynamic
// value in JS before GHL ever sees it (GHL does zero merge-tag substitution, so the old
// "(Insert billing link)" leak class is structurally impossible here).
//
// `sms` is OPTIONAL. notify() only sends the SMS leg when env.SMS_AUTH_ENABLED === 'true' (A2P gate),
// so leaving sms set is safe — it just queues until A2P clears.

const ORANGE = '#ff6b35';

// ── shared helpers ───────────────────────────────────────────────────────────
export function money(cents) {
  return '$' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
}
function appBase(env) {
  return (env && (env.APP_BASE_URL || env.GT_APP_BASE_URL)) || 'https://gainztrainprep.com';
}
function link(env, path = '/app/') {
  return appBase(env) + path;
}
// Render a long ISO/date string as "Tuesday, June 10" (UTC-safe, no time).
function prettyDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  } catch { return String(iso); }
}
// For Stripe timestamps (renewal / cancel dates): render in the business timezone so the date lines up
// with when the charge actually happens, not a UTC date that can read a day off. (week_of date-only
// strings keep using prettyDate/UTC.)
function prettyDateLocal(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Denver' });
  } catch { return String(iso); }
}

// Branded email shell. `cta` is optional { label, href }.
function layout(env, { heading, intro, rows = [], note, cta }) {
  const rowsHtml = rows.length
    ? `<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:15px;color:#1a1614">` +
      rows.map((r) =>
        `<tr><td style="padding:8px 0;color:#7a7270">${r[0]}</td>` +
        `<td style="padding:8px 0;text-align:right;font-weight:600">${r[1]}</td></tr>`).join('') +
      `</table>`
    : '';
  const ctaHtml = cta
    ? `<p style="margin:24px 0 8px"><a href="${cta.href}" style="display:inline-block;background:${ORANGE};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">${cta.label}</a></p>`
    : '';
  const noteHtml = note ? `<p style="font-size:13px;color:#7a7270;margin-top:18px">${note}</p>` : '';
  return (
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1614">` +
    `<div style="font-size:22px;font-weight:800;letter-spacing:.5px;padding:8px 0">GAINZ<span style="color:${ORANGE}">TRAIN</span></div>` +
    `<h1 style="font-size:21px;margin:14px 0 8px">${heading}</h1>` +
    (intro ? `<p style="font-size:15px;line-height:1.5">${intro}</p>` : '') +
    rowsHtml + ctaHtml + noteHtml +
    `<hr style="border:none;border-top:1px solid #ede9e3;margin:26px 0 12px">` +
    `<p style="font-size:12px;color:#9a928e">Gainz Train · high-protein meal prep · Utah<br>` +
    `Questions? Just reply to this email.</p></div>`
  );
}

const PRORATE_NOTE = 'This change takes effect for this week, prorated — Stripe charges the difference (or credits you) on your card automatically.';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// meals = [{ name, qty }]. Render only the picked ones. Defensive: returns nothing for a non-array
// (the `meals` key is a number in tier_changed and an array here — never crash on the wrong shape).
function mealItems(meals) {
  // Require a name too — a renumbered/removed menu position must never render "2x undefined".
  return Array.isArray(meals) ? meals.filter((m) => m && m.qty > 0 && m.name) : [];
}
function mealListHtml(meals) {
  const items = mealItems(meals);
  if (!items.length) return '';
  return `<ul style="margin:14px 0;padding-left:18px;font-size:15px;line-height:1.7;color:#1a1614">` +
    items.map((m) => `<li><strong>${m.qty}×</strong> ${escapeHtml(m.name)}</li>`).join('') + `</ul>`;
}
function mealListSms(meals) {
  return mealItems(meals).map((m) => `${m.qty}x ${m.name}`).join(', ');
}

// ── templates ────────────────────────────────────────────────────────────────
export const TEMPLATES = {
  // ----- Account / self-service confirmations (Step 1) -----
  welcome: (d, env) => ({
    subject: 'Welcome to Gainz Train',
    html: layout(env, {
      heading: `Welcome to Gainz Train${d.firstName ? ', ' + escapeHtml(d.firstName) : ''}! 💪`,
      intro: `Your account is ready. Log in anytime at <a href="${link(env, '/app/')}">${appBase(env).replace('https://', '')}/app</a> with this email${d.hasPassword ? ' and your password' : ' — just choose "Email me a link" to get in'}.`,
      note: 'If you ever forget your password, choose "Email me a link" on the login page.',
      cta: { label: 'Go to your account', href: link(env, '/app/') },
    }),
    sms: `Welcome to Gainz Train! Your account is ready — log in at ${link(env, '/app/')}`,
  }),

  password_changed: (d, env) => ({
    subject: 'Your Gainz Train password was changed',
    html: layout(env, {
      heading: 'Your password was changed',
      intro: 'Heads up — the password on your Gainz Train account was just updated. If this was you, you\'re all set and nothing else is needed.',
      note: 'If you did NOT do this, reply to this email right away so we can lock your account.',
      cta: { label: 'Go to your account', href: link(env, '/app/') },
    }),
    sms: 'Gainz Train: your account password was just changed. If this wasn\'t you, reply STOP-no, reply to your email, or contact us right away.',
  }),

  paused: (d, env) => ({
    subject: 'Your Gainz Train meals are paused',
    html: layout(env, {
      heading: 'Your meals are paused',
      intro: 'Done — your subscription is paused. You won\'t be charged and we won\'t cook for you until you resume. Your plan and meal preferences are saved exactly as they were.',
      cta: { label: 'Resume anytime', href: link(env, '/app/manage/') },
    }),
    sms: 'Gainz Train: your meals are paused — no charges until you resume. Resume anytime at ' + link(env, '/app/manage/'),
  }),

  resumed: (d, env) => ({
    subject: 'You\'re back on — Gainz Train meals resume',
    html: layout(env, {
      heading: 'Welcome back — your meals are resuming',
      intro: 'Your subscription is active again. Billing picks back up on your normal schedule and you\'re back in the weekly menu rotation. Don\'t forget to pick your meals before the Friday cutoff.',
      cta: { label: 'Pick this week\'s meals', href: link(env, '/app/menu/') },
    }),
    sms: 'Gainz Train: your subscription is active again. Pick your meals before Friday: ' + link(env, '/app/menu/'),
  }),

  canceled: (d, env) => ({
    subject: 'Your Gainz Train plan ends ' + (prettyDateLocal(d.ends) || 'soon'),
    html: layout(env, {
      heading: 'Your plan is set to cancel',
      intro: `We\'ve scheduled your cancellation. You\'ll keep getting meals through the end of the period you already paid for${d.ends ? `, ending ${prettyDateLocal(d.ends)}` : ''}. No further charges after that.`,
      note: 'Changed your mind? You can undo the cancellation anytime before it ends — nothing is lost.',
      cta: { label: 'Undo cancellation', href: link(env, '/app/manage/') },
    }),
    sms: `Gainz Train: your plan is set to cancel${d.ends ? ' on ' + prettyDateLocal(d.ends) : ''}. Undo anytime before then: ` + link(env, '/app/manage/'),
  }),

  reactivated: (d, env) => ({
    subject: 'You\'re staying — cancellation reversed',
    html: layout(env, {
      heading: 'Cancellation reversed — you\'re staying',
      intro: 'Glad to keep you on the train. Your subscription will continue on its normal weekly schedule. Nothing else to do.',
      cta: { label: 'Manage your plan', href: link(env, '/app/manage/') },
    }),
    sms: 'Gainz Train: your cancellation was reversed — you\'re staying on. See you this week.',
  }),

  tier_changed: (d, env) => ({
    subject: d.nextWeek ? `Your plan changes to ${d.meals} meals/week next week` : `Your plan is now ${d.meals} meals/week`,
    html: layout(env, {
      heading: `You\'re ${d.nextWeek ? 'set for' : 'now on'} ${d.meals} meals a week`,
      intro: d.nextWeek
        ? 'Your meal plan is updated. This week\'s order is already locked in for prep, so the new count starts with next week\'s menu:'
        : 'Your meal plan was updated. Here\'s the new setup:',
      rows: [
        ['Meals per week', String(d.meals)],
        d.perMealCents ? ['Per-meal price', money(d.perMealCents)] : null,
      ].filter(Boolean),
      note: d.nextWeek
        ? 'No change to this week\'s charge or meals — the new amount applies from next week\'s billing.'
        : PRORATE_NOTE,
      cta: { label: d.nextWeek ? 'Set next week\'s meals' : 'Pick your meals', href: link(env, '/app/menu/') },
    }),
    sms: d.nextWeek
      ? `Gainz Train: your plan changes to ${d.meals} meals/week starting next week (this week\'s locked order is unchanged).`
      : `Gainz Train: your plan is now ${d.meals} meals/week. The difference is prorated on your card automatically.`,
  }),

  delivery_changed: (d, env) => {
    const isDelivery = d.method === 'delivery';
    return {
      subject: isDelivery ? 'Your delivery details were updated' : 'You\'re switched to pickup',
      html: layout(env, {
        heading: isDelivery ? 'Delivery details updated' : 'Switched to pickup',
        intro: isDelivery
          ? 'We updated your delivery for this week. Here\'s what\'s on file:'
          : 'You\'re set to pick up your meals at the kitchen — no delivery fee.',
        rows: isDelivery
          ? [['Delivery', `Zone ${d.zone}`], ['Weekly delivery fee', money(d.feeCents)]]
          : [['Pickup', 'Free at the kitchen']],
        note: d.nextWeek
          ? 'This applies from next week — this week\'s order is already locked, so there\'s no change to this week\'s charge or delivery.'
          : PRORATE_NOTE,
        cta: { label: 'Manage your plan', href: link(env, '/app/manage/') },
      }),
      sms: isDelivery
        ? `Gainz Train: delivery updated to Zone ${d.zone} (${money(d.feeCents)}/wk). Prorated on your card automatically.`
        : 'Gainz Train: you\'re switched to free pickup at the kitchen. Any delivery fee is prorated automatically.',
    };
  },

  goal_changed: (d, env) => ({
    subject: 'Your meal goal is set' + (d.goal ? ` to ${d.goal}` : ''),
    html: layout(env, {
      heading: 'Your goal is updated',
      intro: `We\'ll portion your meals to match your goal${d.goal ? ` (${d.goal})` : ''}${d.sex ? ` for ${d.sex} macros` : ''}. This kicks in on your next prep day. No change to your billing.`,
      cta: { label: 'View your plan', href: link(env, '/app/') },
    }),
    sms: `Gainz Train: your meal goal is updated${d.goal ? ' to ' + d.goal : ''}. Portions adjust on your next prep day.`,
  }),

  // ----- Weekly menu + order cycle (Step 4) -----
  meal_reminder: (d, env) => ({
    subject: 'Pick your Gainz Train meals',
    html: layout(env, {
      heading: 'Time to pick your meals 🍱',
      intro: `Your Gainz Train meals for the week of ${prettyDate(d.weekOf)} aren\'t picked yet. Choose your ${d.mealsPerWeek} meals before the Friday cutoff${d.cutoff ? ` (${prettyDate(d.cutoff)})` : ''} or we\'ll repeat last week for you.`,
      cta: { label: 'Pick my meals', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: pick your meals for ${prettyDate(d.weekOf)} before Friday: ${link(env, '/app/menu/')}`,
  }),

  meal_reminder_final: (d, env) => ({
    subject: 'Last call — pick your Gainz Train meals',
    html: layout(env, {
      heading: 'Last call — pick your meals tonight',
      intro: `Ordering for the week of ${prettyDate(d.weekOf)} closes tonight at the Friday cutoff. Choose your ${d.mealsPerWeek} meals now or we\'ll repeat last week for you.`,
      cta: { label: 'Pick my meals', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: LAST CALL — pick your meals before tonight\'s cutoff: ${link(env, '/app/menu/')}`,
  }),

  menu_posted: (d, env) => ({
    subject: 'This week\'s Gainz Train menu is live — pick your meals',
    html: layout(env, {
      heading: 'This week\'s menu is live 🍱',
      intro: `The menu for the week of ${prettyDate(d.weekOf)} just dropped. Head in and pick your meals before the Friday cutoff — if you don\'t, we\'ll repeat last week for you automatically.`,
      cta: { label: 'Pick your meals', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: this week\'s menu is live! Pick your meals before Friday: ` + link(env, '/app/menu/'),
  }),

  order_confirmed: (d, env) => ({
    subject: `You\'re all set — your meals for ${prettyDate(d.weekOf)}`,
    html: layout(env, {
      heading: 'Order confirmed — you\'re all set 💪',
      intro: `Got your picks for the week of ${prettyDate(d.weekOf)}. Here\'s what\'s coming:`,
      rows: [],
      note: (mealListHtml(d.meals) || '') +
        (d.upchargeCents ? `<p style="font-size:13px;color:#7a7270">Includes a ${money(d.upchargeCents)} specialty add-on for this week.</p>` : '') +
        `<p style="font-size:13px;color:#7a7270">You can change your picks anytime before the Friday cutoff.</p>`,
      cta: { label: 'View or edit your order', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: order confirmed for ${prettyDate(d.weekOf)} — ${mealListSms(d.meals)}. Edit before Friday: ` + link(env, '/app/menu/'),
  }),

  order_updated: (d, env) => ({
    subject: `Your meals are updated for ${prettyDate(d.weekOf)}`,
    html: layout(env, {
      heading: 'Order updated ✅',
      intro: `Got it — we updated your meals for the week of ${prettyDate(d.weekOf)}. Here\'s your new lineup:`,
      note: mealListHtml(d.meals) + `<p style="font-size:13px;color:#7a7270">You can keep changing your picks until the Friday cutoff.</p>`,
      cta: { label: 'View your order', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: your order for ${prettyDate(d.weekOf)} is updated — ${mealListSms(d.meals)}. Change again before Friday: ` + link(env, '/app/menu/'),
  }),

  order_locked: (d, env) => ({
    subject: `Your meals are locked in for ${prettyDate(d.weekOf)}`,
    html: layout(env, {
      heading: 'Locked in — we\'re prepping these 🔥',
      intro: `Ordering for the week of ${prettyDate(d.weekOf)} has closed and your order is locked for prep:`,
      note: mealListHtml(d.meals) + `<p style="font-size:13px;color:#7a7270">We\'ll let you know when they\'re on the way.</p>`,
    }),
    sms: `Gainz Train: your ${d.total} meals for ${prettyDate(d.weekOf)} are locked in and headed to prep. ${mealListSms(d.meals)}`,
  }),

  order_autofilled: (d, env) => ({
    subject: 'We picked this week\'s Gainz Train meals for you',
    html: layout(env, {
      heading: 'We picked for you this week',
      intro: `You didn\'t choose your meals before the Friday cutoff for the week of ${prettyDate(d.weekOf)}, so we ${d.source === 'repeat_last_week' ? 'repeated last week\'s order' : 'put together a balanced set'} so you don\'t miss a week:`,
      note: mealListHtml(d.meals) + `<p style="font-size:13px;color:#7a7270">Want different meals next week? Just pick them before Friday and we\'ll use your choices.</p>`,
      cta: { label: 'Set next week\'s meals', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: you didn\'t pick by the cutoff so we chose this week for you — ${mealListSms(d.meals)}. Pick next week anytime: ` + link(env, '/app/menu/'),
  }),

  // ----- Delivery tracker (Step 7) -----
  order_prepped: (d, env) => ({
    subject: 'Your Gainz Train meals are being prepped',
    html: layout(env, {
      heading: 'Cooking now 👨‍🍳',
      intro: `Your meals for the week of ${prettyDate(d.weekOf)} are being prepped fresh in the kitchen. We\'ll let you know the moment they\'re ${d.method === 'delivery' ? 'on the way' : 'ready for pickup'}.`,
      cta: d.trackUrl ? { label: 'Track your order', href: d.trackUrl } : null,
    }),
    sms: `Gainz Train: your meals for ${prettyDate(d.weekOf)} are being prepped. ${d.trackUrl ? 'Track: ' + d.trackUrl : ''}`.trim(),
  }),

  order_out_for_delivery: (d, env) => ({
    subject: 'Your Gainz Train meals are on the way 🚗',
    html: layout(env, {
      heading: 'On the way!',
      intro: `Your meals for the week of ${prettyDate(d.weekOf)} are out for delivery${d.eta ? ` and should arrive around ${d.eta}` : ''}. Get the fridge ready.`,
      cta: d.trackUrl ? { label: 'Track your delivery', href: d.trackUrl } : null,
    }),
    sms: `Gainz Train: your meals are out for delivery${d.eta ? ` (~${d.eta})` : ''}! ${d.trackUrl ? 'Track: ' + d.trackUrl : ''}`.trim(),
  }),

  order_delivered: (d, env) => ({
    subject: 'Delivered — enjoy your Gainz Train meals 💪',
    html: layout(env, {
      heading: 'Delivered!',
      intro: `Your meals for the week of ${prettyDate(d.weekOf)} have been delivered. Enjoy — and crush your week. Not seeing them? Just reply and we\'ll sort it out.`,
    }),
    sms: `Gainz Train: your meals have been delivered. Enjoy! 💪`,
  }),

  order_pickup_ready: (d, env) => ({
    subject: 'Your Gainz Train meals are ready for pickup',
    html: layout(env, {
      heading: 'Ready for pickup 🥡',
      intro: `Your meals for the week of ${prettyDate(d.weekOf)} are ready at the Orem kitchen. Swing by anytime during pickup hours.`,
    }),
    sms: `Gainz Train: your meals are ready for pickup at the Orem kitchen!`,
  }),

  // ----- Billing, fired off the Stripe webhook (Step 2) -----
  order_receipt_first: (d, env) => ({
    subject: `You\'re on the Gainz Train — order confirmed (${money(d.amount)})`,
    html: layout(env, {
      heading: 'You\'re on the train — order confirmed 💪',
      intro: 'Payment received and your subscription is live. Welcome aboard! Here\'s your receipt:',
      rows: [
        ['Charged today', money(d.amount)],
        d.discount ? ['You saved', money(d.discount)] : null,
      ].filter(Boolean),
      note: 'Next step: pick your meals for this week before the Friday cutoff. We\'ll email you when each new menu drops.',
      cta: { label: 'Pick your meals', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: you\'re in! Charged ${money(d.amount)}. Pick your meals before Friday: ` + link(env, '/app/menu/'),
  }),

  renewal_receipt: (d, env) => ({
    subject: `Gainz Train — you were charged ${money(d.amount)} for this week`,
    html: layout(env, {
      heading: 'This week\'s meals are paid 🍱',
      intro: 'Your weekly subscription renewed. Here\'s your receipt:',
      rows: [
        ['Charged', money(d.amount)],
        d.discount ? ['You saved', money(d.discount)] : null,
      ].filter(Boolean),
      note: d.invoiceUrl ? `View or download this receipt anytime.` : undefined,
      cta: d.invoiceUrl ? { label: 'View receipt', href: d.invoiceUrl } : { label: 'Pick your meals', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: you were charged ${money(d.amount)} for this week's meals. 💪`,
  }),

  payment_failed: (d, env) => ({
    subject: 'Your card was declined — update it to keep your meals',
    html: layout(env, {
      heading: 'We couldn\'t process your payment',
      intro: `Your card was declined for this week\'s ${money(d.amount)} charge. No stress — we\'ll automatically try again, but the fastest fix is to update your card now so you don\'t miss a delivery.`,
      cta: { label: 'Update your card', href: d.invoiceUrl || link(env, '/app/manage/') },
      note: 'If you\'ve already fixed it, you can ignore this — the retry will go through.',
    }),
    sms: `Gainz Train: your card was declined for this week (${money(d.amount)}). Update it to keep your meals: ` + (d.invoiceUrl || link(env, '/app/manage/')),
  }),

  payment_failed_final: (d, env) => ({
    subject: 'Your Gainz Train plan is paused — payment couldn\'t be completed',
    html: layout(env, {
      heading: 'Your plan is paused for now',
      intro: 'We tried your card a few times but couldn\'t complete this week\'s payment, so your meals are paused. Update your card and you\'ll be right back on the train — nothing is lost.',
      cta: { label: 'Update your card', href: d.invoiceUrl || link(env, '/app/manage/') },
    }),
    sms: 'Gainz Train: we couldn\'t complete your payment so your meals are paused. Update your card to restart: ' + (d.invoiceUrl || link(env, '/app/manage/')),
  }),

  renewal_upcoming: (d, env) => ({
    subject: `Heads up — your Gainz Train meals renew ${d.when ? prettyDateLocal(d.when) : 'soon'}`,
    html: layout(env, {
      heading: 'Your next week is coming up',
      intro: `Quick heads up: your Gainz Train subscription renews${d.when ? ` on ${prettyDateLocal(d.when)}` : ' soon'}${d.amount ? ` for ${money(d.amount)}` : ''}. Want to change your meals, pause, or switch plans? Do it before then and it\'ll be reflected on this charge.`,
      cta: { label: 'Pick your meals', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: your meals renew${d.when ? ' ' + prettyDateLocal(d.when) : ' soon'}${d.amount ? ' for ' + money(d.amount) : ''}. Change anything before then: ` + link(env, '/app/manage/'),
  }),

  card_expiring: (d, env) => ({
    subject: 'Your card on file expires soon — update it before your next charge',
    html: layout(env, {
      heading: 'Your card is about to expire',
      intro: `The card we have on file${d.last4 ? ` (ending in ${escapeHtml(String(d.last4))})` : ''}${d.month && d.year ? ` expires ${d.month}/${d.year}` : ' is expiring soon'}. Update it now so your meals don\'t skip a beat when your next charge runs.`,
      cta: { label: 'Update your card', href: link(env, '/app/manage/') },
    }),
    sms: `Gainz Train: the card on file${d.last4 ? ' ending in ' + d.last4 : ''} expires soon. Update it before your next charge: ` + link(env, '/app/manage/'),
  }),

  payment_recovered: (d, env) => ({
    subject: 'Payment received — you\'re all set, meals are back on',
    html: layout(env, {
      heading: 'You\'re all set — payment went through 🎉',
      intro: `Good news: we successfully charged your card${d.amount ? ` ${money(d.amount)}` : ''} and your meals are back on track. Thanks for taking care of that!`,
      cta: { label: 'Pick your meals', href: link(env, '/app/menu/') },
    }),
    sms: `Gainz Train: payment went through${d.amount ? ' (' + money(d.amount) + ')' : ''} — you\'re all set and your meals are back on.`,
  }),

  refund_issued: (d, env) => ({
    subject: `Your refund of ${money(d.amount)} is on the way`,
    html: layout(env, {
      heading: 'Your refund is on the way',
      intro: `We\'ve issued a ${d.partial ? 'partial ' : ''}refund of ${money(d.amount)}. It typically lands back on your card in 5-10 business days, depending on your bank.`,
      rows: [['Refund amount', money(d.amount)]],
      note: 'Questions about this refund? Just reply and we\'ll sort it out.',
    }),
    sms: `Gainz Train: a refund of ${money(d.amount)} is on its way back to your card (5-10 business days).`,
  }),

  subscription_ended: (d, env) => ({
    subject: 'Your Gainz Train subscription has ended',
    html: layout(env, {
      heading: 'Your subscription has ended',
      intro: 'Your Gainz Train plan has officially wrapped up. Thanks for riding with us — the door\'s always open if you want to come back. Your account and preferences stay saved.',
      cta: { label: 'Restart anytime', href: link(env, '/start/') },
      note: 'We\'d love to know what we could do better — just reply and let us know.',
    }),
    sms: 'Gainz Train: your subscription has ended. Thanks for riding with us — restart anytime at ' + link(env, '/start/'),
  }),
};

export function hasTemplate(eventKey) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, eventKey);
}
