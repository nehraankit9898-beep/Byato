"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { api, ApiError, storeSessionToken } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Hotel,
  Mail,
  Lock,
  Eye,
  EyeOff,
  Loader2,
  Repeat,
  BellRing,
  BarChart3,
  ShieldCheck,
  Building2,
  ArrowRight,
  ShieldCheck as PlatformIcon,
  KeyRound,
  ArrowLeft,
} from "lucide-react";

/**
 * Sign-in — "Ivory, Ink & Champagne".
 *
 * Presentation only: the auth flow (hotel vs platform admin, MFA challenge,
 * token storage, error copy) is unchanged. The brand column is now an ink panel
 * with an editorial serif line and hairline-separated proof points instead of a
 * saturated gradient; the form column is paper with uppercase micro-labels.
 */
export function LoginScreen({
  onLoggedIn,
  onGoRegister,
}: {
  onLoggedIn: () => void;
  onGoRegister: () => void;
}) {
  const [mode, setMode] = useState<"hotel" | "platform">("hotel");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Phase 10 — TOTP MFA challenge state (after correct password)
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "platform") {
        // Platform Super Admin — dedicated login path (Phase 6)
        const res = await api.post<{
          token?: string;
          sessionToken?: string;
          mfaRequired?: boolean;
          mfaToken?: string;
        }>("/api/super-admin/login", { email, password });
        if (res.mfaRequired && res.mfaToken) {
          setMfaToken(res.mfaToken);
          return;
        }
        const token = res.token ?? res.sessionToken;
        if (token) storeSessionToken(token);
      } else {
        const res = await api.post<{
          sessionToken?: string;
          mfaRequired?: boolean;
          mfaToken?: string;
        }>("/api/auth/login", { email, password });
        if (res.mfaRequired && res.mfaToken) {
          setMfaToken(res.mfaToken);
          return;
        }
        // Persist the fallback token for contexts where cookies are blocked
        // (cross-site iframe embedding). Cookie remains the primary session.
        if (res.sessionToken) storeSessionToken(res.sessionToken);
      }
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign you in. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post<{ sessionToken?: string }>("/api/auth/mfa/verify", {
        mfaToken,
        code: mfaCode,
      });
      if (res.sessionToken) storeSessionToken(res.sessionToken);
      setMfaToken(null);
      setMfaCode("");
      onLoggedIn();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Invalid authentication code. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  function backToPassword() {
    setMfaToken(null);
    setMfaCode("");
    setError(null);
  }

  const proofPoints = [
    { icon: Repeat, text: "Every visit remembered, automatically" },
    { icon: BellRing, text: "Consent-first campaigns — never a cold message" },
    { icon: BarChart3, text: "Retention measured on your own data" },
    { icon: ShieldCheck, text: "Role-based access, tenant-level privacy" },
  ];

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-background">
      {/* Brand panel — ink, hairline gold frame, editorial serif */}
      <div className="lux-ink-panel relative hidden lg:flex lg:w-[47%] flex-col justify-between overflow-hidden p-10 xl:p-14">
        <div className="pointer-events-none absolute inset-4 border border-[color:var(--gold)]/20" />
        <div className="relative">
          <p className="lux-eyebrow" style={{ color: "oklch(0.82 0.07 84)" }}>
            Guest intelligence
          </p>
          <p className="mt-3 font-serif text-[26px] font-semibold uppercase tracking-[0.28em]">
            Beyto
          </p>
        </div>

        <div className="relative max-w-md">
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.05 }}
            className="lux-display text-[44px] xl:text-[52px]"
          >
            Turn one-time guests into <em className="italic text-[color:var(--gold)]">regulars</em>.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.15 }}
            className="mt-6 max-w-sm text-[14px] leading-[1.85] text-[color:oklch(0.78_0.012_82)]"
          >
            Know every guest who walks through your doors. Record visits, keep consent honest, and
            watch your repeat rate rise — quietly, in one place.
          </motion.p>

          <div className="mt-10 border-t border-white/10">
            {proofPoints.map((f, i) => (
              <motion.div
                key={f.text}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.25 + i * 0.08 }}
                className="flex items-center gap-4 border-b border-white/10 py-3.5"
              >
                <f.icon className="h-[15px] w-[15px] shrink-0 text-[color:oklch(0.8_0.075_82)]" />
                <p className="text-[12.5px] tracking-[0.01em] text-[color:oklch(0.88_0.008_85)]">
                  {f.text}
                </p>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="relative flex flex-wrap items-center justify-between gap-y-2 text-[10px] uppercase tracking-[0.18em] text-white/35">
          <span>© {new Date().getFullYear()} Beyto</span>
          {/* Public legal + pricing pages must be reachable BEFORE signup
              (DPDP notice, and the payment provider's refund-policy check). */}
          <nav aria-label="Legal and pricing" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link href="/pricing" className="transition-colors hover:text-white/70">
              Pricing
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-white/70">
              Privacy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-white/70">
              Terms
            </Link>
            <Link href="/refund-policy" className="transition-colors hover:text-white/70">
              Refunds
            </Link>
          </nav>
        </div>
      </div>

      {/* Form panel — paper */}
      <div className="flex flex-1 items-center justify-center px-6 py-12 sm:px-10">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="w-full max-w-[400px]"
        >
          {/* Mobile wordmark */}
          <div className="mb-10 flex flex-col items-center gap-2 lg:hidden">
            <div className="flex h-11 w-11 items-center justify-center rounded-[4px] border border-[color:var(--gold)]/40 bg-[color:oklch(0.2_0.012_72)] text-[color:oklch(0.82_0.075_82)]">
              <Hotel className="h-5 w-5" />
            </div>
            <p className="mt-1 font-serif text-[20px] font-semibold uppercase tracking-[0.26em]">
              Beyto
            </p>
          </div>

          <div>
            <p className="lux-eyebrow">
              {mode === "platform" ? "Platform control" : "Welcome back"}
            </p>
            <h2 className="lux-display mt-3 text-[34px]">
              {mode === "platform" ? "Platform admin" : "Sign in"}
            </h2>
            <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
              {mode === "platform"
                ? "Sign in to the multi-hotel platform control centre."
                : "Continue to your guests, campaigns and reports."}
            </p>
          </div>

          {/* Mode switch — hairline segmented control */}
          <div
            className="mt-7 grid grid-cols-2 gap-0 border-b border-[color:var(--border)]"
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "hotel"}
              onClick={() => {
                setMode("hotel");
                setError(null);
              }}
              className={`flex items-center justify-center gap-2 border-b pb-3 text-[10.5px] font-medium uppercase tracking-[0.14em] transition-colors duration-300 ${
                mode === "hotel"
                  ? "border-[color:var(--gold)] text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Hotel className="h-3.5 w-3.5" /> Hotel sign-in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "platform"}
              onClick={() => {
                setMode("platform");
                setError(null);
              }}
              className={`flex items-center justify-center gap-2 border-b pb-3 text-[10.5px] font-medium uppercase tracking-[0.14em] transition-colors duration-300 ${
                mode === "platform"
                  ? "border-[color:var(--gold)] text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <PlatformIcon className="h-3.5 w-3.5" /> Platform admin
            </button>
          </div>

          {error && (
            <Alert variant="destructive" className="mt-6 rounded-[4px]">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {mfaToken ? (
            <form onSubmit={handleMfaVerify} className="mt-6 space-y-5">
              <div className="border-l-2 border-[color:var(--gold)] bg-[color:var(--porcelain)] px-4 py-3">
                <p className="flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.14em] text-[color:var(--gold-ink)]">
                  <KeyRound className="h-3.5 w-3.5" /> Two-factor authentication
                </p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                  Enter the 6-digit code from your authenticator app, or one of your single-use
                  backup codes.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mfa-code" className={labelClass}>
                  Authentication code
                </Label>
                <Input
                  id="mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="••••••"
                  className="h-11 rounded-[4px] text-center text-[17px] tracking-[0.4em] font-mono"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\s/g, ""))}
                  maxLength={10}
                  autoFocus
                  required
                />
              </div>
              <Button
                type="submit"
                className={primaryButtonClass}
                disabled={loading || mfaCode.length < 6}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
                  </>
                ) : (
                  <>
                    Verify and sign in <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
              <button
                type="button"
                onClick={backToPassword}
                className="flex w-full items-center justify-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className={labelClass}>
                  Email address
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@yourrestaurant.com"
                    className={inputClass}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className={labelClass}>
                  Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    className={`${inputClass} pr-10`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 transition-colors hover:text-foreground"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <Button type="submit" className={primaryButtonClass} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Signing you in…
                  </>
                ) : (
                  <>
                    {mode === "platform" ? "Sign in as super admin" : "Sign in"}{" "}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </form>
          )}

          {/* Security notice (Phase 2): demo credentials removed from the UI */}
          <div className="mt-7 border-l-2 border-[color:var(--gold)]/60 pl-4 text-[11.5px] leading-relaxed text-muted-foreground">
            Sign in with the account created for your hotel. Hotel owners receive a one-time
            invitation link; platform super admins are provisioned through a secure bootstrap
            process.
          </div>

          {mode === "hotel" && (
            <p className="mt-8 border-t border-[color:var(--border)] pt-6 text-[12.5px] text-muted-foreground">
              New restaurant?{" "}
              <button
                type="button"
                onClick={onGoRegister}
                className="group inline-flex items-center gap-1.5 font-medium text-[color:var(--gold-ink)] transition-colors hover:text-foreground"
              >
                <Building2 className="h-3.5 w-3.5" />
                Register your restaurant
                <ArrowRight className="h-3 w-3 transition-transform duration-300 group-hover:translate-x-0.5" />
              </button>
            </p>
          )}
        </motion.div>
      </div>
    </div>
  );
}

/* Shared field styling — keeps labels, inputs and the primary action in one
   place so the sign-in and MFA forms stay identical. */
const labelClass = "text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground";
const inputClass =
  "h-11 rounded-[4px] border-[color:var(--border)] bg-white/60 pl-10 text-[13.5px] shadow-none focus-visible:ring-1 focus-visible:ring-[color:var(--gold)] focus-visible:ring-offset-0";
const primaryButtonClass =
  "h-11 w-full rounded-[4px] bg-[color:var(--ink)] text-[11px] font-medium uppercase tracking-[0.16em] text-[color:oklch(0.98_0.004_90)] hover:bg-[color:oklch(0.29_0.01_72)]";
