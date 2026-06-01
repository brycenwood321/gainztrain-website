// POST /api/account/goal — set the customer's goal + sex (drives meal macros/portions, not price).
// Body { goal: 'cut'|'maintain'|'build', sex: 'male'|'female' }. Both optional; only provided ones update.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { str } from '../../_lib/validate.js';

const GOALS = new Set(['cut', 'maintain', 'build']);
const SEXES = new Set(['male', 'female']);

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');

  const body = await readJson(request);
  const goal = str(body.goal).toLowerCase();
  const sex = str(body.sex).toLowerCase();
  if (goal && !GOALS.has(goal)) return fail(400, 'invalid_goal', 'Goal must be cut, maintain, or build.');
  if (sex && !SEXES.has(sex)) return fail(400, 'invalid_sex', 'Sex must be male or female.');
  if (!goal && !sex) return fail(400, 'nothing_to_update', 'Provide a goal and/or sex.');

  await run(env.DB,
    `UPDATE customers SET goal = COALESCE(NULLIF(?,''), goal), sex = COALESCE(NULLIF(?,''), sex), updated_at = ? WHERE id = ?`,
    goal, sex, nowIso(), auth.customer.id);
  return ok({ goal: goal || auth.customer.goal, sex: sex || auth.customer.sex });
}
