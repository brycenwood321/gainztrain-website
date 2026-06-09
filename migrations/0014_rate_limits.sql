-- 0014: fixed-window rate-limit counters in D1 (the auth surface had no rate limiting — login
-- brute-force, register email-bomb/enumeration, magic-link + SMS-OTP flooding). Keyed per bucket
-- (e.g. login:ip:1.2.3.4, login:email:x@y.com). Pruned opportunistically by the limiter + the cron.
CREATE TABLE rate_limits (
  bucket        TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  TEXT NOT NULL
);
