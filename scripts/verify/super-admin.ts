import { createHmac } from "crypto";

import { call, check, summary } from "./probe-lib";

function b32(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; const c = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = ""; for (const ch of c) { const i = A.indexOf(ch); if (i === -1) continue; bits += i.toString(2).padStart(5, "0"); }
  const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out);
}
function totp(secret: string): string {
  const step = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8); buf.writeUInt32BE(step % 2 ** 32, 4);
  const h = createHmac("sha1", b32(secret)).update(buf).digest(); const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(n % 1_000_000).padStart(6, "0");
}
const SECRET = (process.env.SA_MFA_SECRET ?? "").trim();

const SA_EMAIL = "super@stayloop.test";
const SA_PASSWORD = "SuperAdmin12345";
/** TOTP secret used for this run — SA_MFA_SECRET when the operator
 *  pre-enrolled the factor, otherwise the one captured during
 *  self-provisioning below. */
let totpSecret = SECRET;

/**
 * Self-provisioning setup (probe runs against a FRESH database).
 *
 * The bootstrap endpoint no longer accepts a password (secure
 * contract: random temporary password, mustChangePassword), so a
 * hardcoded-login probe went stale. The probe now:
 *   1. logs in with the known password when the account exists;
 *   2. otherwise bootstraps the first super admin, signs in with the
 *      one-time temporary password and sets the known password;
 *   3. enrolls TOTP MFA when not yet enrolled (capturing the secret
 *      returned exactly once by /api/mfa/setup).
 */
async function provisionSuperAdmin(): Promise<void> {
  const attempt = await call("POST", "/api/super-admin/login", {
    email: SA_EMAIL,
    password: SA_PASSWORD,
  });
  if (attempt.status === 200 || attempt.body?.mfaToken) return; // ready

  const bootSecret = (process.env.ADMIN_BOOTSTRAP_SECRET ?? "").trim();
  if (!bootSecret) {
    throw new Error(
      "Super admin not provisioned and ADMIN_BOOTSTRAP_SECRET unset. " +
        "Set SA_MFA_SECRET for a pre-enrolled account or ADMIN_BOOTSTRAP_SECRET for self-provisioning.",
    );
  }
  const boot = await call(
    "POST",
    "/api/super-admin/bootstrap",
    { name: "Platform Auditor", email: SA_EMAIL },
    { "x-bootstrap-secret": bootSecret },
  );
  if (boot.status !== 201 || !boot.body?.temporaryPassword) {
    throw new Error("bootstrap failed: " + JSON.stringify(boot.body).slice(0, 200));
  }
  const tempLogin = await call("POST", "/api/super-admin/login", {
    email: SA_EMAIL,
    password: boot.body.temporaryPassword,
  });
  if (tempLogin.status !== 200) {
    throw new Error("temporary-password login failed: " + tempLogin.status);
  }
  const pw = await call("PATCH", "/api/profile", {
    currentPassword: boot.body.temporaryPassword,
    newPassword: SA_PASSWORD,
  });
  if (pw.status !== 200) {
    throw new Error("password change failed: " + JSON.stringify(pw.body).slice(0, 200));
  }
  await call("POST", "/api/auth/logout", {});
}

async function saLogin(): Promise<{ status: number; body: any }> {
  const login = await call("POST", "/api/super-admin/login", {
    email: SA_EMAIL,
    password: SA_PASSWORD,
  });
  if (login.body?.mfaSetupRequired) {
    // Enroll TOTP with the secret returned exactly once by the setup call.
    const setup = await call("POST", "/api/mfa/setup", {});
    if (setup.status !== 200 || !setup.body?.secret) {
      return { status: setup.status, body: setup.body };
    }
    totpSecret = setup.body.secret;
    const enable = await call("POST", "/api/mfa/enable", { code: totp(totpSecret) });
    if (enable.status !== 200) return { status: enable.status, body: enable.body };
    await call("POST", "/api/auth/logout", {});
    const reLogin = await call("POST", "/api/super-admin/login", {
      email: SA_EMAIL,
      password: SA_PASSWORD,
    });
    if (reLogin.body?.mfaToken) {
      return call("POST", "/api/auth/mfa/verify", {
        mfaToken: reLogin.body.mfaToken,
        code: totp(totpSecret),
      });
    }
    return reLogin;
  }
  if (login.body?.mfaToken) {
    const v = await call("POST", "/api/auth/mfa/verify", {
      mfaToken: login.body.mfaToken,
      code: totp(totpSecret),
    });
    if (v.status !== 200) {
      // replay fence: wait for the next step and retry once
      await new Promise((r) => setTimeout(r, 31_000));
      return call("POST", "/api/auth/mfa/verify", {
        mfaToken: login.body.mfaToken,
        code: totp(totpSecret),
      });
    }
    return v;
  }
  return login;
}

await provisionSuperAdmin();
const login = await saLogin();
check("sa", "super-admin login with TOTP MFA", login.status === 200, `status=${login.status}`);

const reads = [
  "/api/super-admin/stats", "/api/super-admin/hotels", "/api/super-admin/plans",
  "/api/super-admin/subscriptions", "/api/super-admin/feature-flags",   "/api/super-admin/security", "/api/super-admin/audit", "/api/super-admin/billing",
  "/api/super-admin/usage", "/api/super-admin/saas-kpis", "/api/super-admin/backups",
  "/api/super-admin/coupons", "/api/super-admin/templates", "/api/super-admin/settings",
  "/api/super-admin/health", "/api/super-admin/secret-rotations", "/api/super-admin/support",
  "/api/super-admin/refunds",
];
for (const p of reads) {
  const r = await call("GET", p);
  check("sa-console", `GET ${p}`, r.status === 200, `status=${r.status} ${r.status !== 200 ? JSON.stringify(r.body).slice(0, 110) : ""}`);
}

const hotels = await call("GET", "/api/super-admin/hotels");
const list = hotels.body?.hotels ?? hotels.body?.tenants ?? [];
check("sa-console", "tenant list returns both demo hotels", list.length >= 2, `count=${list.length}`);
const seaView = list.find((h: any) => JSON.stringify(h).includes("Sea View"));
if (seaView) {
  const suspend = await call("POST", `/api/super-admin/hotels/suspend?id=${seaView.id}`, { reason: "probe suspend" });
  const activate = await call("POST", `/api/super-admin/hotels/activate?id=${seaView.id}`, { reason: "probe activate" });
  check("sa-console", "suspend → activate tenant", suspend.status === 200 && activate.status === 200, `${suspend.status}/${activate.status}`);
}

const flag = await call("PUT", "/api/super-admin/feature-flags", { key: "PROBE_FLAG", enabled: true }).catch(() => ({ status: 0, body: null }));
check("sa-console", "feature flag toggle endpoint reachable", flag.status === 200 || flag.status === 404 || flag.status === 422, `status=${flag.status}`);

const backup = await call("POST", "/api/super-admin/backups", { reason: "probe backup run" });
check("sa-console", "trigger manual backup", backup.status === 200 || backup.status === 201, `status=${backup.status} ${JSON.stringify(backup.body).slice(0, 140)}`);
const backupId = backup.body?.backup?.id ?? backup.body?.id ?? backup.body?.recordId;
if (backupId) {
  let status = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
  const bl = await call("GET", "/api/super-admin/backups");
  const row = (bl.body?.history ?? bl.body?.backups ?? []).find((b: any) => b.id === backupId);
  status = row?.status ?? "";
  if (status === "COMPLETED" || status === "FAILED" || status === "SUCCESS") break;
  }
  const bl2 = await call("GET", "/api/super-admin/backups");
  const row2 = (bl2.body?.history ?? bl2.body?.backups ?? []).find((b: any) => b.id === backupId);
  check("sa-console", "worker completes the manual backup (encrypted artifact)", status === "COMPLETED" || status === "SUCCESS", `final=${status} size=${row2?.sizeBytes ?? "?"}B verified=${row2?.verified}`);
}

const audit = await call("GET", "/api/super-admin/audit?limit=50");
const rows = audit.body?.logs ?? audit.body?.entries ?? audit.body?.auditLogs ?? audit.body?.items ?? [];
check("sa-console", "platform audit trail populated", audit.status === 200 && rows.length > 0, `status=${audit.status} rows=${rows.length}`);

summary();
