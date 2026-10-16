import { NextResponse } from "next/server";
import { timingSafeEqual, createHash } from "crypto";
import { ConfigValidationError, getAdminBootstrapSecret } from "@/lib/config";
import { bootstrapFirstSuperAdmin, BootstrapConflictError } from "@/lib/super-admin";
import { db } from "@/lib/db";
import { z } from "zod";
import { parseWith } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { requestIp } from "@/lib/login-security";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const bootstrapBodySchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
});

/** Constant-time secret comparison. Both sides are hashed so lengths match. */
function secretMatches(provided: string, configured: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(provided), digest(configured));
}

/**
 * POST /api/super-admin/bootstrap — one-time Super Admin provisioning.
 *
 * Response contract (every branch is deliberate; see tests/bootstrap-endpoint.test.ts):
 *   403 BOOTSTRAP_DISABLED      ADMIN_BOOTSTRAP_SECRET is not configured (fail closed)
 *   500 BOOTSTRAP_MISCONFIGURED ADMIN_BOOTSTRAP_SECRET is set but weak / a placeholder
 *   401 UNAUTHORIZED            x-bootstrap-secret header missing or wrong
 *   429 RATE_LIMITED            too many attempts from this client IP
 *   400 BAD_REQUEST             body is not { name, email }
 *   409 ALREADY_BOOTSTRAPPED    a Super Admin already exists
 *   409 EMAIL_IN_USE            the email belongs to an existing user
 *   201                         created; the temporary password is returned ONCE
 *   500 INTERNAL                unexpected failure (details only in server logs)
 *
 * Requirements:
 *   - The secret is read from ADMIN_BOOTSTRAP_SECRET and supplied in the
 *     `x-bootstrap-secret` header (not in the body, not in a query string).
 *   - Works ONLY while no Super Admin exists (single-use; atomic claim in
 *     src/lib/super-admin.ts prevents two concurrent creations).
 *   - The account gets a cryptographically random temporary password that is
 *     returned ONCE in this response and must be changed at first sign-in
 *     (mustChangePassword). Neither the password nor the secret is logged.
 */
export async function POST(req: Request) {
  try {
    const clientIp = requestIp(req);
    const burst = await checkRateLimit(`sa-bootstrap:${clientIp}`, 5, 60 * 1000);
    if (!burst.allowed) {
      return NextResponse.json(
        {
          error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait and try again." },
        },
        { status: 429 },
      );
    }

    let configuredSecret: string;
    try {
      configuredSecret = getAdminBootstrapSecret();
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        // The message names the variable and the rule, never the value.
        logger.error("bootstrap.misconfigured", { message: err.message });
        return NextResponse.json(
          {
            error: {
              code: "BOOTSTRAP_MISCONFIGURED",
              message:
                "ADMIN_BOOTSTRAP_SECRET is invalid on this deployment. Replace it with a random value of at least 32 characters and redeploy.",
            },
          },
          { status: 500 },
        );
      }
      throw err;
    }
    if (!configuredSecret) {
      // Fail closed: bootstrap disabled unless explicitly configured.
      return NextResponse.json(
        {
          error: {
            code: "BOOTSTRAP_DISABLED",
            message: "Bootstrap is not enabled on this deployment.",
          },
        },
        { status: 403 },
      );
    }

    // Trim like the configured side: a stray space or newline from copy/paste
    // must not turn a correct secret into a 401.
    const provided = (req.headers.get("x-bootstrap-secret") ?? "").trim();
    if (!provided || !secretMatches(provided, configuredSecret)) {
      await logAudit({
        req,
        action: "BOOTSTRAP_DENIED",
        entityType: "user",
        metadata: { reason: provided ? "invalid bootstrap secret" : "missing bootstrap secret" },
        ipAddress: clientIp,
      });
      return NextResponse.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: provided
              ? "Invalid bootstrap secret."
              : "Missing x-bootstrap-secret header. Send ADMIN_BOOTSTRAP_SECRET in that header.",
          },
        },
        { status: 401 },
      );
    }

    // Validate the body before touching the database: a malformed request
    // never costs a query, and the 400 path is independent of DB state.
    const body = await req.json().catch(() => null);
    const parsed = parseWith(bootstrapBodySchema, body);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: parsed.error ?? "name and email are required." } },
        { status: 400 },
      );
    }

    const existingCount = await db.user.count({ where: { role: "SUPER_ADMIN" } });
    if (existingCount > 0) {
      return NextResponse.json(
        { error: { code: "ALREADY_BOOTSTRAPPED", message: "A Super Admin already exists." } },
        { status: 409 },
      );
    }

    const result = await bootstrapFirstSuperAdmin({
      name: parsed.data.name,
      email: parsed.data.email,
      bootstrapSecret: configuredSecret,
    });

    return NextResponse.json(
      {
        ok: true,
        admin: { id: result.id, email: result.email },
        // One-time temporary password — the operator must hand it to the admin
        // over a secure channel. Never returned again; never logged.
        temporaryPassword: result.temporaryPassword,
        mustChangePassword: true,
        message: "Store this temporary password securely now — it will not be shown again.",
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof BootstrapConflictError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 409 },
      );
    }
    // Never echo internal error text (Prisma / connection details) to the
    // client. Log only the error class so the operator can investigate.
    logger.error("bootstrap.failed", { errorName: err instanceof Error ? err.name : "unknown" });
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL",
          message: "Bootstrap failed due to a server error. Check the server logs.",
        },
      },
      { status: 500 },
    );
  }
}
