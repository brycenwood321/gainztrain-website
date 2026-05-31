// Thin D1 helpers. The binding is context.env.DB (see wrangler.toml).
// All timestamps are ISO-8601 UTC. Money is integer cents.

export function nowIso() {
  return new Date().toISOString();
}

export function addDaysIso(days, from = Date.now()) {
  return new Date(from + days * 86400000).toISOString();
}

export function addMinutesIso(mins, from = Date.now()) {
  return new Date(from + mins * 60000).toISOString();
}

// Fetch a single row (or null).
export async function one(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

// Fetch all rows as an array.
export async function all(db, sql, ...params) {
  const r = await db.prepare(sql).bind(...params).all();
  return r.results || [];
}

// Execute a write; returns D1 run metadata.
export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

// Run several statements atomically (D1 batch).
export async function batch(db, statements) {
  return db.batch(statements);
}
