import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Lets the Decline button on a "calling" notification decline without opening the app. Bound
 * to one call and one person; useless once the call stops ringing.
 */
export function callDeclineToken(secret: string, callId: string, userId: string): string {
  return createHmac('sha256', secret)
    .update(`call-decline:${callId}:${userId}`)
    .digest('base64url');
}

export function validCallDeclineToken(
  secret: string,
  callId: string,
  userId: string,
  token: string,
): boolean {
  const expected = Buffer.from(callDeclineToken(secret, callId, userId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
