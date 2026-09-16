// homeState: the ONE computation behind the customer Home card. Classic script (no module syntax) so
// the page can call it directly and test/home_state.test.mjs can evaluate it in a node vm context.
//
// Inputs are the two payloads the page already fetches: `me` from /api/me and `menu` from
// /api/menu/current, plus `now` (ms). Nothing here reads the DOM, the clock, or Stripe.
//
// PRECEDENCE follows functions/_lib/decide.js, re-derived for the customer's inputs (the lock reads
// live Stripe objects; this reads D1 status, cancel_at_period_end and the invoices list):
//   1. no plan / plan ended        2. paused          3. past due (open invoice => on hold,
//   settled => still cooks)        4. the week being delivered (locked, prepping, out, ready, done)
//   5. the orderable week (menu not posted / pick / partial / set)
// A queued cancel is a NOTE on whichever state wins, never a state of its own, except that it turns
// "Renews" into "Ends". Copy never shows a Stripe status word: 'trialing' is a live plan.
//
// Return shape: { state, headline, sub, cta: {label, href} | null, note: {text, tone} | null,
//                 tracker: {steps: [{label, done, now}]} | null, meals: [...] | null,
//                 next: { state, headline, sub, cta } | null, week_of }
function homeState(me, menu, now) {
  now = now || Date.now();
  var c = (me && me.customer) || {};
  var s = me && me.subscription;
  var orders = (me && me.orders) || [];
  var out = { state: '', headline: '', sub: '', cta: null, note: null, tracker: null, meals: null, next: null, week_of: null };

  var DEAD = { canceled: 1, incomplete: 1, incomplete_expired: 1 };
  if (!s) {
    out.state = 'no_plan'; out.headline = 'No plan yet'; out.sub = 'Pick your meals and we cook them Saturday.';
    out.cta = { label: 'Start a plan', href: '/start/' }; return out;
  }
  if (DEAD[s.status]) {
    out.state = 'plan_ended'; out.headline = 'Your plan has ended';
    out.sub = s.current_period_end ? 'Last week was ' + fmtLong(s.current_period_end) + '.' : 'Come back any time.';
    out.cta = { label: 'Start again', href: '/start/' }; return out;
  }

  // Which week is which. menu.week_of is the ORDERABLE week (rolls forward at the Friday cutoff).
  // The week being delivered is the Sunday on or after today in Mountain time; when that is earlier
  // than the orderable week, there is an order to track and a next week to pick.
  var deliverySunday = sundayOnOrAfter(now);
  var orderableWeek = menu && menu.week_of;
  var deliveryOrder = findOrder(orders, deliverySunday);
  var trackingWeek = orderableWeek && deliverySunday < orderableWeek && deliveryOrder ? deliverySunday : null;
  out.week_of = trackingWeek || orderableWeek || deliverySunday;

  var endsNote = s.cancel_at_period_end && s.current_period_end
    ? { text: 'Your plan ends after ' + fmtLong(s.current_period_end) + '. Changed your mind? Undo it under Account.', tone: 'amber' } : null;
  // A queued cancel means Stripe will NOT renew at current_period_end, so any orderable week whose
  // Sunday falls after that date is never charged and never cooked (review P1, 2026-09-16). That week
  // gets the cancel card, not a "Pick your meals" it cannot use.
  var cancelKills = !!(s.cancel_at_period_end && s.current_period_end && orderableWeek && orderableWeek > String(s.current_period_end).slice(0, 10));

  if (s.status === 'paused') {
    out.state = 'paused'; out.headline = 'Paused'; out.sub = 'No meals and no charges until you resume.';
    out.cta = { label: 'Resume my plan', href: '/app/manage/' }; out.note = endsNote; return out;
  }
  var open = (me.open_invoices || 0) > 0;
  var cardIssue = s.status === 'past_due' || s.status === 'unpaid';
  // A settled past-due card with meals already in motion: the tracker wins, the card issue is a note.
  if (cardIssue && (open || !trackingWeek)) {
    out.state = open ? 'past_due_hold' : 'past_due_cooks';
    out.headline = 'Card issue';
    out.sub = open ? "Sunday's meals are on hold until your card goes through." : "This week's meals still cook. Update your card so they keep coming.";
    out.cta = { label: 'Update card', href: '/app/manage/#billing' }; out.note = endsNote;
    return out;
  }

  // 4. A week in motion: locked and cooking, out, ready, delivered.
  if (trackingWeek) {
    var st = deliveryOrder.delivery_status || 'scheduled';
    var pickup = c.delivery_method !== 'delivery';
    var flow = pickup
      ? [['scheduled', 'Locked'], ['prepping', 'Cooking'], ['pickup_ready', 'Ready'], ['picked_up', 'Picked up']]
      : [['scheduled', 'Locked'], ['prepping', 'Cooking'], ['out_for_delivery', 'On the way'], ['delivered', 'Delivered']];
    var idx = Math.max(0, flow.findIndex(function (f) { return f[0] === st; }));
    out.tracker = { steps: flow.map(function (f, i) { return { label: f[1], done: i < idx, now: i === idx }; }) };
    out.meals = mealsFor(me, trackingWeek);
    var when = fmtLong(trackingWeek);
    if (st === 'delivered' || st === 'picked_up') {
      out.state = 'delivered'; out.headline = st === 'delivered' ? 'Delivered' : 'Picked up';
      out.sub = (deliveryOrder.delivered_at ? fmtTime(deliveryOrder.delivered_at) + '. ' : '') + 'Enjoy the week.';
    } else if (st === 'out_for_delivery') {
      out.state = 'delivery_out'; out.headline = 'On the way'; out.sub = 'Your meals are out for delivery today.';
    } else if (st === 'pickup_ready') {
      out.state = 'delivery_ready'; out.headline = 'Ready for pickup';
      out.sub = me.pickup && me.pickup.windowLabel ? 'Today ' + me.pickup.windowLabel + ' at ' + (me.pickup.addressShort || me.pickup.address || 'the kitchen') + '.' : 'Ready at the kitchen today.';
    } else if (st === 'prepping') {
      out.state = 'delivery_prepping'; out.headline = 'Cooking now'; out.sub = (pickup ? 'Ready for pickup ' : 'Arriving ') + when + '.';
    } else {
      out.state = 'delivery_locked'; out.headline = 'Locked in';
      out.sub = (deliveryOrder.total_meals ? deliveryOrder.total_meals + ' meals. ' : '') + (pickup ? 'Ready for pickup ' : 'Arriving ') + when + '.';
    }
    out.note = cardIssue ? { text: 'Card issue. Update your card under Account so next week keeps coming.', tone: 'red' } : endsNote;
    out.next = cancelKills ? cancelCard(me, orders, s, true) : openWeekCard(me, menu, now, true);
    return out;
  }

  // 5. The orderable week, unless the queued cancel already ended it.
  if (cancelKills) {
    var cc = cancelCard(me, orders, s, false);
    out.state = cc.state; out.headline = cc.headline; out.sub = cc.sub; out.cta = cc.cta; return out;
  }
  var card = openWeekCard(me, menu, now, false);
  out.state = card.state; out.headline = card.headline; out.sub = card.sub; out.cta = card.cta; out.meals = card.meals; out.note = endsNote;
  return out;
}

function cancelCard(me, orders, s, asNext) {
  var endDate = String(s.current_period_end).slice(0, 10);
  var last = null;
  for (var i = 0; i < orders.length; i++) if (orders[i].week_of && orders[i].week_of <= endDate && (!last || orders[i].week_of > last)) last = orders[i].week_of;
  return {
    state: 'cancel_scheduled',
    headline: asNext ? 'Next week' : 'Your plan is ending',
    sub: (last ? 'Your last delivery is ' + fmtLong(last) + '. ' : 'No more deliveries after ' + fmtLong(s.current_period_end) + '. ') + 'Changed your mind? You can undo it any time before then.',
    cta: { label: 'Undo cancellation', href: '/app/manage/' },
    meals: null,
  };
}

function openWeekCard(me, menu, now, asNext) {
  var s = me.subscription || {};
  var week = menu && menu.week_of;
  var when = week ? fmtLong(week) : 'Sunday';
  var card = { state: '', headline: '', sub: '', cta: null, meals: null };
  if (menu && (menu.ordering_closed || menu.locked)) {
    // Saturday blackout, or a locked week with nothing to track (a customer who signed up after the
    // cutoff): say when ordering opens. Checked BEFORE has_menu, because during the blackout the next
    // menu is usually not posted yet and "Menu coming" would hide the real answer.
    card.state = 'menu_not_posted'; card.headline = asNext ? 'Next week' : 'Ordering opens Sunday';
    card.sub = 'The new menu drops Sunday.'; return card;
  }
  if (!menu || !menu.has_menu) {
    card.state = 'menu_not_posted'; card.headline = asNext ? 'Next week' : 'Menu coming';
    card.sub = "Next week's menu is not posted yet. We email you when it is."; return card;
  }
  var need = menu.meals_per_week || s.meals_per_week || 0;
  var sel = (menu.selections || []).reduce(function (a, x) { return a + (x.qty || 0); }, 0);
  var left = timeLeft(menu.cutoff, now);
  var cut = 'Pick by ' + fmtCutoff(menu.cutoff) + (left ? ', ' + left + ' left' : '');
  if (sel >= need && need > 0) {
    card.state = 'open_picked'; card.headline = (asNext ? 'Next week: ' : '') + need + ' meals set';
    card.sub = 'For ' + when + '. You can change them until ' + fmtCutoff(menu.cutoff) + '.';
    card.cta = { label: 'Edit meals', href: '/app/menu/' }; card.meals = mealsFor(me, week, menu);
  } else if (sel > 0) {
    card.state = 'open_partial'; card.headline = sel + ' of ' + need + ' picked';
    card.sub = cut + '. Finish your picks for ' + when + '.';
    card.cta = { label: 'Finish picking', href: '/app/menu/' };
  } else {
    card.state = 'open_unpicked'; card.headline = asNext ? 'Pick next week' : 'Pick your meals';
    card.sub = cut + '. ' + need + ' meals for ' + when + '.';
    card.cta = { label: 'Pick meals', href: '/app/menu/' };
  }
  return card;
}

// ---- helpers (all pure) ----
var TZ = 'America/Denver';
function partsIn(ms) {
  var f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  var o = {}; f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
  return o;
}
function sundayOnOrAfter(ms) {
  var p = partsIn(ms);
  var dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  var d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  d.setUTCDate(d.getUTCDate() + ((7 - dow) % 7));
  return d.toISOString().slice(0, 10);
}
function findOrder(orders, week) { for (var i = 0; i < orders.length; i++) if (orders[i].week_of === week) return orders[i]; return null; }
function mealsFor(me, week, menu) {
  var rows = (me.meal_history || []).filter(function (m) { return m.week_of === week && m.qty > 0; });
  if (!rows.length && menu && menu.selections) rows = menu.selections.filter(function (x) { return x.qty > 0; }).map(function (x) {
    var meal = (menu.meals || []).find(function (mm) { return mm.position === x.meal_position; }) || {};
    return { meal_name: meal.name || ('Meal ' + x.meal_position), qty: x.qty, image: meal.image || null, emoji: meal.emoji || null };
  });
  if (!rows.length) return null;
  return rows.map(function (r) { return { name: r.meal_name, qty: r.qty, image: r.image || null, emoji: r.emoji || null }; });
}
function valid(d) { return d instanceof Date && !isNaN(d.getTime()); }
function fmtLong(iso) {
  if (!iso) return '';
  var d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00Z') : new Date(iso);
  if (!valid(d)) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' }).format(d);
}
function fmtTime(iso) { var d = new Date(iso); return valid(d) ? new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d) : ''; }
function fmtCutoff(iso) {
  if (!iso) return 'Friday midnight';
  var d = new Date(iso);
  if (!valid(d)) return 'Friday midnight';
  // The cutoff is Friday 23:59 Mountain; say "Friday 11:59 pm" rather than a midnight that reads as Saturday.
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(d).replace(' AM', ' am').replace(' PM', ' pm');
}
function timeLeft(iso, now) {
  if (!iso) return '';
  var ms = new Date(iso).getTime() - now;
  if (isNaN(ms)) return '';
  if (ms <= 0) return '';
  var h = Math.floor(ms / 3600000);
  if (h >= 48) return Math.floor(h / 24) + ' days';
  if (h >= 24) return '1 day';
  if (h >= 1) return h + (h === 1 ? ' hour' : ' hours');
  return Math.max(1, Math.floor(ms / 60000)) + ' min';
}
function greeting(first, now) {
  var h = +partsIn(now || Date.now()).hour;
  var g = h < 12 ? 'Morning' : (h < 17 ? 'Afternoon' : 'Evening');
  return first ? g + ', ' + first : g;
}
if (typeof window !== 'undefined') { window.homeState = homeState; window.gtGreeting = greeting; }
