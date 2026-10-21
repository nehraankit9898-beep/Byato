"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { api, ApiError } from "@/lib/api-client";
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
  User,
  MapPin,
  Phone,
  ArrowLeft,
  CheckCircle2,
} from "lucide-react";

/**
 * Registration — "Ivory, Ink & Champagne".
 *
 * Presentation only: same endpoint, same validation and same success state as
 * before. The form now sits on paper beside an ink panel, with uppercase
 * micro-labels and a single ink primary action.
 */
export function RegisterScreen({ onGoLogin }: { onGoLogin: () => void }) {
  const [form, setForm] = useState({
    hotelName: "",
    location: "",
    hotelPhone: "",
    adminName: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (form.password !== form.confirm) {
      setError("Passwords do not match. Please re-enter them.");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/hotels", {
        hotelName: form.hotelName,
        location: form.location,
        hotelPhone: form.hotelPhone,
        adminName: form.adminName,
        email: form.email,
        password: form.password,
      });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not register your restaurant. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="lux-sheen flex min-h-screen items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="lux-card w-full max-w-md p-10 text-center"
        >
          <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full border border-[color:var(--gold)]/40 text-[color:var(--gold-ink)]">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <p className="lux-eyebrow">Welcome</p>
          <h1 className="lux-display mt-3 text-[32px]">Restaurant registered</h1>
          <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">{form.hotelName}</span> is ready. You can
            now sign in with <span className="font-medium text-foreground">{form.email}</span>.
          </p>
          <Button className={`${primaryButtonClass} mt-8`} onClick={onGoLogin}>
            Continue to sign in
          </Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      {/* Brand panel — ink, hairline frame, editorial serif */}
      <div className="lux-ink-panel relative hidden lg:flex lg:w-[38%] flex-col justify-between overflow-hidden p-10 xl:p-12">
        <div className="pointer-events-none absolute inset-4 border border-[color:var(--gold)]/20" />
        <div className="relative">
          <p className="lux-eyebrow" style={{ color: "oklch(0.82 0.07 84)" }}>
            Begin
          </p>
          <p className="mt-3 font-serif text-[24px] font-semibold uppercase tracking-[0.28em]">
            Beyto
          </p>
        </div>

        <div className="relative max-w-xs">
          <h2 className="lux-display text-[38px] leading-[1.08]">
            A quiet room for your <em className="italic text-[color:var(--gold)]">guests</em>.
          </h2>
          <p className="mt-5 text-[13px] leading-[1.85] text-[color:oklch(0.78_0.012_82)]">
            Set up in minutes. Your first campaign can go out the same evening.
          </p>
          <div className="mt-9 border-t border-white/10">
            {[
              "Ten-minute setup, no card required",
              "WhatsApp templates approved with you",
              "Guest consent recorded, never assumed",
            ].map((line) => (
              <p
                key={line}
                className="border-b border-white/10 py-3 text-[12px] leading-relaxed text-[color:oklch(0.88_0.008_85)]"
              >
                {line}
              </p>
            ))}
          </div>
        </div>

        <div className="relative flex flex-wrap items-center justify-between gap-y-2 text-[10px] uppercase tracking-[0.18em] text-white/35">
          <span>© {new Date().getFullYear()} Beyto</span>
          {/* Consent is collected in this flow — the notice must be one tap away. */}
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
      <div className="flex flex-1 items-start justify-center px-6 py-10 sm:px-10 lg:items-center">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="w-full max-w-[520px]"
        >
          <button
            type="button"
            onClick={onGoLogin}
            className="mb-8 inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </button>

          <div className="flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-[4px] border border-[color:var(--gold)]/40 bg-[color:oklch(0.2_0.012_72)] text-[color:oklch(0.82_0.075_82)]">
              <Hotel className="h-4.5 w-4.5" />
            </div>
            <p className="font-serif text-[18px] font-semibold uppercase tracking-[0.24em]">
              Beyto
            </p>
          </div>

          <div className="mt-6 lg:mt-0">
            <p className="lux-eyebrow">New restaurant</p>
            <h1 className="lux-display mt-3 text-[34px]">Register your restaurant</h1>
            <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
              Create your workspace in under a minute. You&apos;ll be the first admin.
            </p>
          </div>

          <hr className="lux-rule my-7" />

          {error && (
            <Alert variant="destructive" className="mb-6 rounded-[4px]">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="hotelName" className={labelClass}>
                  Restaurant name *
                </Label>
                <div className="relative">
                  <Hotel className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="hotelName"
                    placeholder="e.g. The Rose Court"
                    className={inputClass}
                    value={form.hotelName}
                    onChange={(e) => set("hotelName", e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="location" className={labelClass}>
                  City / location
                </Label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="location"
                    placeholder="Jaipur"
                    className={inputClass}
                    value={form.location}
                    onChange={(e) => set("location", e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="hotelPhone" className={labelClass}>
                  Contact phone
                </Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="hotelPhone"
                    placeholder="+91 98765 43210"
                    className={inputClass}
                    value={form.hotelPhone}
                    onChange={(e) => set("hotelPhone", e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="adminName" className={labelClass}>
                  Your full name *
                </Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="adminName"
                    placeholder="e.g. Arjun Mehta"
                    className={inputClass}
                    value={form.adminName}
                    onChange={(e) => set("adminName", e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="reg-email" className={labelClass}>
                  Work email *
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="reg-email"
                    type="email"
                    placeholder="you@yourrestaurant.com"
                    className={inputClass}
                    value={form.email}
                    onChange={(e) => set("email", e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reg-password" className={labelClass}>
                  Password *
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="reg-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Min 8 chars, 1 number"
                    className={`${inputClass} pr-10`}
                    value={form.password}
                    onChange={(e) => set("password", e.target.value)}
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

              <div className="space-y-2">
                <Label htmlFor="confirm" className={labelClass}>
                  Confirm password *
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    id="confirm"
                    type={showPassword ? "text" : "password"}
                    placeholder="Repeat password"
                    className={inputClass}
                    value={form.confirm}
                    onChange={(e) => set("confirm", e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>

            <Button type="submit" className={primaryButtonClass} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Creating your workspace…
                </>
              ) : (
                "Create restaurant workspace"
              )}
            </Button>

            <p className="border-t border-[color:var(--border)] pt-5 text-center text-[11px] leading-relaxed text-muted-foreground">
              By registering you agree to record guest marketing consent honestly. Guests can opt
              out at any time — Beyto enforces it automatically.
            </p>
          </form>
        </motion.div>
      </div>
    </div>
  );
}

/* Shared field styling, kept in sync with the sign-in screen. */
const labelClass = "text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground";
const inputClass =
  "h-11 rounded-[4px] border-[color:var(--border)] bg-white/60 pl-10 text-[13.5px] shadow-none focus-visible:ring-1 focus-visible:ring-[color:var(--gold)] focus-visible:ring-offset-0";
const primaryButtonClass =
  "h-11 w-full rounded-[4px] bg-[color:var(--ink)] text-[11px] font-medium uppercase tracking-[0.16em] text-[color:oklch(0.98_0.004_90)] hover:bg-[color:oklch(0.29_0.01_72)]";
