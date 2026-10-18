import { checkRateLimit, clientIp } from "@/lib/rate-limit";

const TOKEN_LIMITS = { read: 60, checkout: 10, verify: 30 } as const;

/**
 * Public payment endpoints share the production Redis limiter. The link token
 * owns the primary budget so customers behind a shared venue IP do not block
 * one another. A per-IP budget at 10x the token limit is retained as a broad
 * abuse backstop; IP identity always comes from the trusted proxy chain.
 */
export async function limitPaymentLinkRequest(
  req: Request,
  action: keyof typeof TOKEN_LIMITS,
  token: string,
) {
  const tokenBucket = /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : "invalid";
  const ip = clientIp(req);
  const [tokenResult, ipResult] = await Promise.all([
    checkRateLimit(`payment-link:${action}:token:${tokenBucket}`, TOKEN_LIMITS[action], 60_000),
    checkRateLimit(`payment-link:${action}:ip:${ip}`, TOKEN_LIMITS[action] * 10, 60_000),
  ]);
  if (tokenResult.allowed && ipResult.allowed) return null;

  const retryAfterSeconds = Math.max(tokenResult.retryAfterSeconds, ipResult.retryAfterSeconds);
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
