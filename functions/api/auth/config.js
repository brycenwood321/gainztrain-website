// GET /api/auth/config — which login methods are live (SMS is gated until A2P clears).
import { ok } from '../../_lib/respond.js';

export async function onRequestGet(context) {
  const smsEnabled = context.env.SMS_AUTH_ENABLED === 'true';
  return ok({
    methods: ['magic_link', 'password', ...(smsEnabled ? ['sms_otp'] : [])],
    sms_enabled: smsEnabled,
  });
}
