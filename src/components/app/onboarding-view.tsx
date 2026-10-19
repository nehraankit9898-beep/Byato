"use client";

/**
 * Onboarding wizard — first-run setup guide for a new hotel/restaurant owner.
 *
 * Goal: time-to-value in minutes, not hours. A fresh owner lands here right
 * after registration (or via "Setup Guide" in the sidebar) and walks through
 * the four tasks that make the product work for their business:
 *
 *   1. Digital menu  — first category + first dishes
 *   2. QR code       — the table QR guests scan (download + print ready)
 *   3. First guest   — add the first customer record with marketing consent
 *   4. First campaign— a welcome message draft (consent-first, DRAFT status)
 *
 * Every step reads LIVE state from the existing APIs, so the wizard also works
 * for existing tenants: completed tasks are shown as done, and anything the
 * owner already has (menu items, QR codes, customers, campaigns) is detected
 * automatically — nothing is created twice.
 *
 * The wizard NEVER sends a real campaign (it creates a DRAFT) and never
 * bypasses the server-side permission matrix: it only calls the same
 * tenant-scoped APIs the regular views use.
 */

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { QrCodeRow, QrCodesResponse, SessionUser, ViewId } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChefHat,
  Copy,
  Download,
  ExternalLink,
  Gift,
  IndianRupee,
  Leaf,
  Loader2,
  MessageSquareText,
  PartyPopper,
  QrCode as QrIcon,
  Rocket,
  Send,
  SkipForward,
  Sparkles,
  UserPlus,
} from "lucide-react";

/** localStorage key (per hotel) — set when the owner skips or finishes. */
export const onboardingDismissedKey = (hotelId: string) =>
  `stayloop_onboarding_dismissed:${hotelId}`;

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(minor / 100);

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

interface StepMeta {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepMeta[] = [
  { id: "menu", label: "Digital Menu", icon: BookOpen },
  { id: "qr", label: "Table QR", icon: QrIcon },
  { id: "customer", label: "First Guest", icon: UserPlus },
  { id: "campaign", label: "Welcome Message", icon: MessageSquareText },
];

function StepDone({
  title,
  children,
  onContinue,
  continueLabel = "Continue",
  busyLabel,
}: {
  title: string;
  children?: React.ReactNode;
  onContinue: () => void;
  continueLabel?: string;
  busyLabel?: string;
}) {
  return (
    <div className="space-y-5 text-center py-4">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
        <CheckCircle2 className="h-7 w-7 text-emerald-600" />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-lg font-bold">{title}</h3>
        {children}
      </div>
      <Button onClick={onContinue}>{busyLabel ?? continueLabel}</Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main wizard                                                         */
/* ------------------------------------------------------------------ */

export function OnboardingView({
  user,
  setView,
}: {
  user: SessionUser;
  setView: (v: ViewId) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // 0 = welcome, 1..4 = steps, 5 = done
  const [step, setStep] = useState(0);

  /* -------- live completion state (works for existing tenants too) ----- */
  const categoriesQ = useQuery({
    queryKey: ["onboarding", "menu-categories"],
    queryFn: () =>
      api.get<{
        categories: { id: string; name: string; itemCount: number }[];
      }>("/api/menu/categories"),
  });
  const itemsQ = useQuery({
    queryKey: ["onboarding", "menu-items"],
    queryFn: () =>
      api.get<{ items: { id: string; name: string; priceMinor: number }[] }>("/api/menu/items"),
  });
  const qrQ = useQuery({
    queryKey: ["onboarding", "qr-codes"],
    queryFn: () => api.get<QrCodesResponse>("/api/qr-codes"),
  });
  const customersQ = useQuery({
    queryKey: ["onboarding", "customers"],
    queryFn: () => api.get<{ total: number }>("/api/customers?page=1&pageSize=1"),
  });
  const campaignsQ = useQuery({
    queryKey: ["onboarding", "campaigns"],
    queryFn: () => api.get<{ campaigns: unknown[]; providerMode: string }>("/api/campaigns"),
  });

  const itemCount = itemsQ.data?.items?.length ?? 0;
  const qrCount = qrQ.data?.qrCodes?.length ?? 0;
  const customerCount = customersQ.data?.total ?? 0;
  const campaignCount = campaignsQ.data?.campaigns?.length ?? 0;

  const done = useMemo(
    () => ({
      menu: itemCount > 0,
      qr: qrCount > 0,
      customer: customerCount > 0,
      campaign: campaignCount > 0,
    }),
    [itemCount, qrCount, customerCount, campaignCount],
  );
  const completedCount = Object.values(done).filter(Boolean).length;

  function refreshLiveState() {
    void qc.invalidateQueries({ queryKey: ["onboarding"] });
  }

  /** Mark dismissed + land on the dashboard. */
  function finishWizard() {
    try {
      window.localStorage.setItem(onboardingDismissedKey(user.hotelId), "1");
    } catch {
      // storage unavailable — the wizard simply re-opens next login
    }
    setView("dashboard");
  }

  const stepIndex = Math.min(Math.max(step, 0), 5);

  return (
    <div className="space-y-6">
      {/* ---------------- Wizard header ---------------- */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge className="bg-primary/10 text-primary border border-primary/20 hover:bg-primary/10">
              <Sparkles className="h-3 w-3 mr-1" /> Setup guide
            </Badge>
            {completedCount === 4 && (
              <Badge className="bg-emerald-600 hover:bg-emerald-600">
                <Check className="h-3 w-3 mr-1" /> All done
              </Badge>
            )}
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">
            {stepIndex === 0
              ? `Welcome to Beyto, ${user.name.split(" ")[0]}! 🎉`
              : stepIndex === 5
                ? "Your setup is complete"
                : `Step ${Math.min(stepIndex, 4)} of 4 — ${STEPS[stepIndex - 1]?.label ?? ""}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {stepIndex === 0
              ? `Get ${user.hotelName} ready in about 10 minutes. Four quick steps — no app, no hardware.`
              : stepIndex === 5
                ? "Everything is in place. Here is what to do next."
                : "You can skip any step and come back later — your progress is saved."}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={finishWizard} className="text-muted-foreground">
          <SkipForward className="h-4 w-4 mr-1.5" />
          {completedCount === 4 ? "Finish setup" : "Skip for now"}
        </Button>
      </div>

      {/* ---------------- Step rail ---------------- */}
      <div className="grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => {
          const isDone = done[s.id as keyof typeof done];
          const active = stepIndex === i + 1;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(i + 1)}
              className={cn(
                "flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors",
                active
                  ? "border-primary bg-primary/5"
                  : isDone
                    ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/40"
                    : "border-border bg-card hover:bg-muted/50",
              )}
            >
              <span className="flex items-center gap-1.5">
                <s.icon
                  className={cn(
                    "h-4 w-4",
                    isDone ? "text-emerald-600" : active ? "text-primary" : "text-muted-foreground",
                  )}
                />
                {isDone ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <span className="text-[10px] font-semibold text-muted-foreground">
                    STEP {i + 1}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "text-xs font-semibold leading-tight",
                  isDone ? "text-emerald-700 dark:text-emerald-400" : "text-foreground",
                )}
              >
                {s.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* ---------------- Step body ---------------- */}
      <Card>
        <CardContent className="p-6">
          {stepIndex === 0 ? (
            <WelcomeStep
              hotelName={user.hotelName}
              done={done}
              loading={itemsQ.isLoading || qrQ.isLoading}
              onStart={() => {
                // Jump to the first incomplete step (or straight to done).
                const firstOpen = (["menu", "qr", "customer", "campaign"] as const).find(
                  (k) => !done[k],
                );
                setStep(
                  firstOpen
                    ? (["menu", "qr", "customer", "campaign"] as const).indexOf(firstOpen) + 1
                    : 5,
                );
              }}
            />
          ) : stepIndex === 1 ? (
            <MenuStep
              categories={categoriesQ.data?.categories ?? []}
              loadingCategories={categoriesQ.isLoading}
              itemCount={itemCount}
              onChanged={refreshLiveState}
              onContinue={() => setStep(2)}
            />
          ) : stepIndex === 2 ? (
            <QrStep
              hotelName={user.hotelName}
              existing={qrQ.data?.qrCodes ?? []}
              loading={qrQ.isLoading}
              onChanged={refreshLiveState}
              onContinue={() => setStep(3)}
            />
          ) : stepIndex === 3 ? (
            <CustomerStep
              customerCount={customerCount}
              onChanged={refreshLiveState}
              onContinue={() => setStep(4)}
            />
          ) : stepIndex === 4 ? (
            <CampaignStep
              hotelName={user.hotelName}
              campaignCount={campaignCount}
              providerMode={campaignsQ.data?.providerMode ?? ""}
              onChanged={refreshLiveState}
              onContinue={() => setStep(5)}
              onGoIntegrations={() => setView("integrations")}
            />
          ) : (
            <FinishStep
              hotelName={user.hotelName}
              done={done}
              setView={setView}
              onFinish={finishWizard}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 0 — Welcome / live checklist                                   */
/* ------------------------------------------------------------------ */

function WelcomeStep({
  hotelName,
  done,
  loading,
  onStart,
}: {
  hotelName: string;
  done: Record<"menu" | "qr" | "customer" | "campaign", boolean>;
  loading: boolean;
  onStart: () => void;
}) {
  const rows: { key: keyof typeof done; label: string; sub: string }[] = [
    {
      key: "menu",
      label: "Add your digital menu",
      sub: "Dishes with prices guests see on their phone",
    },
    {
      key: "qr",
      label: "Create your table QR code",
      sub: "Guests scan → see menu, join loyalty, give feedback",
    },
    {
      key: "customer",
      label: "Add your first guest",
      sub: "Start the customer list your campaigns go to",
    },
    {
      key: "campaign",
      label: "Write your welcome message",
      sub: "A ready-to-review first campaign draft",
    },
  ];
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <div className="hidden sm:flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Rocket className="h-6 w-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-bold">{hotelName} — let's get repeat customers</h3>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Beyto remembers every guest, brings them back with loyalty points and WhatsApp offers,
              and turns feedback into better ratings. First, four quick setup steps.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))
          : rows.map((r) => (
              <div
                key={r.key}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3.5",
                  done[r.key]
                    ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/40"
                    : "border-border",
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                    done[r.key]
                      ? "border-emerald-300 bg-emerald-600 text-white dark:border-emerald-800"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {done[r.key] ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <span className="text-xs font-bold">•</span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-tight">{r.label}</p>
                  <p className="text-xs text-muted-foreground">{r.sub}</p>
                </div>
                {done[r.key] && (
                  <Badge
                    variant="outline"
                    className="border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400"
                  >
                    Done
                  </Badge>
                )}
              </div>
            ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <Button size="lg" onClick={onStart} className="flex-1">
          <Rocket className="h-4 w-4 mr-1.5" />
          {Object.values(done).some(Boolean) ? "Continue setup" : "Start setup — 10 minutes"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1 — Digital menu                                               */
/* ------------------------------------------------------------------ */

function MenuStep({
  categories,
  loadingCategories,
  itemCount,
  onChanged,
  onContinue,
}: {
  categories: { id: string; name: string; itemCount: number }[];
  loadingCategories: boolean;
  itemCount: number;
  onChanged: () => void;
  onContinue: () => void;
}) {
  const { toast } = useToast();

  const [categoryName, setCategoryName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [itemDiet, setItemDiet] = useState("VEG");

  const createCategory = useMutation({
    mutationFn: (name: string) =>
      api.post<{ category: { id: string; name: string } }>("/api/menu/categories", { name }),
    onSuccess: (data) => {
      onChanged();
      setCategoryName("");
      if (data?.category?.id) setCategoryId(data.category.id);
      toast({
        title: "Category created",
        description: `${data?.category?.name ?? "Category"} is ready.`,
      });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not create category",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const createItem = useMutation({
    mutationFn: (body: {
      categoryId: string;
      name: string;
      priceMinor: number;
      dietaryTags: string[];
      description?: string;
    }) => api.post("/api/menu/items", body),
    onSuccess: () => {
      onChanged();
      setItemName("");
      setItemPrice("");
      toast({ title: "Dish added to your menu 🍽️", description: itemName });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not add dish",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (loadingCategories) {
    return (
      <div className="space-y-3 py-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  // Already done (or enough items added during this step).
  if (itemCount > 0) {
    return (
      <StepDone
        title={itemCount === 1 ? "Your first dish is live!" : `${itemCount} dishes are live!`}
        onContinue={onContinue}
      >
        <p className="text-sm text-muted-foreground">
          Guests will see these on the digital menu when they scan your QR. You can add photos,
          option groups and more categories anytime from{" "}
          <span className="font-medium text-foreground">Restaurant Operations → Digital Menu</span>.
        </p>
      </StepDone>
    );
  }

  const needsCategory = categories.length === 0;
  const priceMinor = Math.round(Number(itemPrice) * 100);
  const itemValid =
    !needsCategory &&
    !!categoryId &&
    itemName.trim().length >= 2 &&
    Number.isFinite(priceMinor) &&
    priceMinor > 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" /> Build your digital menu
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Your menu is what guests see after scanning the table QR — photos, prices and veg/non-veg
          marks, no app needed. Start with one category and a few bestsellers.
        </p>
      </div>

      {needsCategory ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (categoryName.trim().length >= 2) createCategory.mutate(categoryName.trim());
          }}
          className="space-y-3 rounded-xl border p-4"
        >
          <Label htmlFor="ob-category">First menu category</Label>
          <div className="flex flex-wrap gap-1.5">
            {["Starters", "Main Course", "Breads", "Rice & Biryani", "Beverages", "Desserts"].map(
              (c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategoryName(c)}
                  className="rounded-full border px-3 py-1 text-xs font-medium hover:bg-muted transition-colors"
                >
                  {c}
                </button>
              ),
            )}
          </div>
          <div className="flex gap-2">
            <Input
              id="ob-category"
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder="e.g. Main Course"
              maxLength={80}
            />
            <Button
              type="submit"
              disabled={categoryName.trim().length < 2 || createCategory.isPending}
            >
              {createCategory.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create
            </Button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (itemValid)
              createItem.mutate({
                categoryId,
                name: itemName.trim(),
                priceMinor,
                dietaryTags: [itemDiet],
              });
          }}
          className="space-y-4 rounded-xl border p-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Category</Label>
              <Select value={categoryId || categories[0]?.id} onValueChange={setCategoryId}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="Choose category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Type</Label>
              <Select value={itemDiet} onValueChange={setItemDiet}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="VEG">🌱 Veg</SelectItem>
                  <SelectItem value="NON_VEG">Non-veg</SelectItem>
                  <SelectItem value="JAIN">Jain</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="ob-item-name">Dish name</Label>
              <Input
                id="ob-item-name"
                className="mt-1.5"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder="e.g. Paneer Tikka Masala"
                maxLength={120}
              />
            </div>
            <div>
              <Label htmlFor="ob-item-price">Price (₹)</Label>
              <div className="relative mt-1.5">
                <IndianRupee className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="ob-item-price"
                  className="pl-9"
                  type="number"
                  min={1}
                  step="1"
                  value={itemPrice}
                  onChange={(e) => setItemPrice(e.target.value)}
                  placeholder="249"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {itemDiet === "VEG" || itemDiet === "JAIN" ? (
                <span className="inline-flex items-center gap-1">
                  <Leaf className="h-3 w-3 text-green-600" /> Marked veg on the menu
                </span>
              ) : (
                "Marked non-veg on the menu"
              )}
            </p>
            <Button type="submit" disabled={!itemValid || createItem.isPending}>
              {createItem.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Add dish
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 — Table QR                                                   */
/* ------------------------------------------------------------------ */

function QrStep({
  hotelName,
  existing,
  loading,
  onChanged,
  onContinue,
}: {
  hotelName: string;
  existing: QrCodeRow[];
  loading: boolean;
  onChanged: () => void;
  onContinue: () => void;
}) {
  const { toast } = useToast();
  const [type, setType] = useState("LOYALTY");
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<QrCodeRow | null>(null);

  const createQr = useMutation({
    mutationFn: (body: { type: string; label: string }) =>
      api.post<{ qrCode: QrCodeRow }>("/api/qr-codes", body),
    onSuccess: (data) => {
      onChanged();
      setCreated(data?.qrCode ?? null);
      toast({
        title: "QR code created! 📱",
        description: "Download it and stick it on your tables.",
      });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not create QR code",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const showQr = created ?? existing[0] ?? null;

  if (loading) {
    return (
      <div className="space-y-3 py-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (showQr) {
    return (
      <div className="grid gap-6 sm:grid-cols-[auto,1fr] sm:items-center">
        <div className="mx-auto rounded-2xl border bg-white p-4 shadow-sm">
          <QrImage url={showQr.url} size={180} />
          <p className="mt-2 text-center text-[11px] font-medium text-zinc-500">
            {showQr.label ?? hotelName}
          </p>
        </div>
        <div className="space-y-4">
          <StepDoneLike
            title="Your QR is ready!"
            body={
              <>
                <p className="text-sm text-muted-foreground">
                  Print it and place it on tables, the billing counter or delivery packs. Guests
                  scan with their phone camera — no app. They see your menu, join your loyalty
                  program and can leave feedback.
                </p>
              </>
            }
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => downloadQr(showQr)}>
              <Download className="h-4 w-4 mr-1.5" /> PNG
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(showQr.url)
                  .then(() => toast({ title: "Link copied" }))
                  .catch(() => window.open(showQr.url, "_blank"));
              }}
            >
              <Copy className="h-4 w-4 mr-1.5" /> Copy link
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.open(showQr.url, "_blank")}>
              <ExternalLink className="h-4 w-4 mr-1.5" /> Preview
            </Button>
          </div>
          <div>
            <Button onClick={onContinue}>
              Continue <Check className="h-4 w-4 ml-1.5" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const labelValid = label.trim().length >= 2;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold flex items-center gap-2">
          <QrIcon className="h-5 w-5 text-primary" /> Create your table QR
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          This QR is the bridge between your counter and your customer list. Every scan is a chance
          to turn a one-time diner into a regular.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (labelValid) createQr.mutate({ type, label: label.trim() });
        }}
        className="space-y-4 rounded-xl border p-4 max-w-lg"
      >
        <div>
          <Label>What should the QR do?</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="LOYALTY">Join loyalty + feedback (recommended)</SelectItem>
              <SelectItem value="MENU">Show digital menu</SelectItem>
              <SelectItem value="FEEDBACK">Collect feedback</SelectItem>
              <SelectItem value="ORDER">Table ordering</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Tip: create one “Loyalty join” QR for all tables to start. You can add table-wise
            ordering QRs later from QR Codes.
          </p>
        </div>
        <div>
          <Label htmlFor="ob-qr-label">Label</Label>
          <Input
            id="ob-qr-label"
            className="mt-1.5"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Table QR / Front counter"
            maxLength={80}
          />
        </div>
        <Button type="submit" className="w-full" disabled={!labelValid || createQr.isPending}>
          {createQr.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create QR code
        </Button>
      </form>
    </div>
  );
}

function StepDoneLike({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-lg font-bold flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" /> {title}
      </h3>
      {body}
    </div>
  );
}

/** Render the QR image into a data URL (same approach as QrCodesView). */
function QrImage({ url, size }: { url: string; size: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, {
      width: size * 2,
      margin: 2,
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((d) => {
        if (alive) setSrc(d);
      })
      .catch(() => {
        // ignore render failures — the URL link still works
      });
    return () => {
      alive = false;
    };
  }, [url, size]);
  return src ? (
    <img src={src} alt="QR code" width={size} height={size} />
  ) : (
    <div style={{ width: size, height: size }} className="animate-pulse rounded-lg bg-zinc-200" />
  );
}

function downloadQr(qr: QrCodeRow) {
  QRCode.toDataURL(qr.url, { width: 720, margin: 3 })
    .then((dataUrl) => {
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `beyto-qr-${qr.code}.png`;
      a.click();
    })
    .catch(() => {
      window.open(qr.url, "_blank");
    });
}

/* ------------------------------------------------------------------ */
/* Step 3 — First guest                                                */
/* ------------------------------------------------------------------ */

function CustomerStep({
  customerCount,
  onChanged,
  onContinue,
}: {
  customerCount: number;
  onChanged: () => void;
  onContinue: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(true);

  const createCustomer = useMutation({
    mutationFn: (body: {
      name: string;
      phone: string;
      marketingConsent: boolean;
      consentSource: string;
      whatsappOptIn: boolean;
    }) => api.post("/api/customers", body),
    onSuccess: () => {
      onChanged();
      setName("");
      setPhone("");
      toast({
        title: "Guest added 👥",
        description: "Their visits and loyalty points will now be tracked.",
      });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not add guest",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (customerCount > 0) {
    return (
      <StepDone
        title={customerCount === 1 ? "First guest is in!" : `${customerCount} guests and counting!`}
        onContinue={onContinue}
      >
        <p className="text-sm text-muted-foreground">
          Your customer list is the heart of Beyto — every visit, loyalty point and campaign is
          built on it. Keep adding guests from the Customers tab, or import your whole list from
          Excel with Import Data.
        </p>
      </StepDone>
    );
  }

  const valid = name.trim().length >= 2 && phone.trim().length >= 10;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-primary" /> Add your first guest
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Start your customer list with a regular you already know. With their consent, they'll get
          your loyalty points and offers on WhatsApp.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid)
            createCustomer.mutate({
              name: name.trim(),
              phone: phone.trim(),
              marketingConsent: consent,
              consentSource: "MANUAL_ENTRY",
              whatsappOptIn: consent,
            });
        }}
        className="space-y-4 rounded-xl border p-4 max-w-lg"
      >
        <div>
          <Label htmlFor="ob-cust-name">Guest name</Label>
          <Input
            id="ob-cust-name"
            className="mt-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ramesh Sharma"
            maxLength={100}
          />
        </div>
        <div>
          <Label htmlFor="ob-cust-phone">Mobile number</Label>
          <Input
            id="ob-cust-phone"
            className="mt-1.5"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="98XXXXXXXX"
            inputMode="tel"
            maxLength={15}
          />
        </div>
        <label className="flex items-start gap-2.5 rounded-lg bg-muted/50 p-3 cursor-pointer">
          <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} />
          <span className="text-xs text-muted-foreground leading-relaxed">
            This guest agreed to receive offers and updates from us (marketing consent). Consent is
            recorded with a timestamp — you can change it anytime on their profile.
          </span>
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <Button type="submit" className="flex-1" disabled={!valid || createCustomer.isPending}>
            {createCustomer.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Add guest
          </Button>
          <Button type="button" variant="ghost" onClick={onContinue}>
            I'll do this later
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4 — First campaign (DRAFT — never auto-sends)                  */
/* ------------------------------------------------------------------ */

function CampaignStep({
  hotelName,
  campaignCount,
  providerMode,
  onChanged,
  onContinue,
  onGoIntegrations,
}: {
  hotelName: string;
  campaignCount: number;
  providerMode: string;
  onChanged: () => void;
  onContinue: () => void;
  onGoIntegrations: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("Welcome offer");
  const [message, setMessage] = useState(
    `Hi {{name}}! Thank you for visiting ${hotelName} 🙏 Show this message on your next visit for a special welcome treat. Reply STOP to opt out.`,
  );

  const segmentsQ = useQuery({
    queryKey: ["onboarding", "segments"],
    queryFn: () =>
      api.get<{ segments: { id: string; name: string; isSystem: boolean; memberCount: number }[] }>(
        "/api/segments",
      ),
  });

  const segments = segmentsQ.data?.segments ?? [];
  // Prefer the "All customers" system segment; fall back to the first segment.
  const defaultSegment =
    segments.find((s) => s.name.toLowerCase().includes("all")) ?? segments[0] ?? null;

  const createCampaign = useMutation({
    mutationFn: (body: {
      name: string;
      segmentId: string;
      channels: string[];
      messageTemplate: string;
      scheduleType: string;
    }) => api.post("/api/campaigns", body),
    onSuccess: () => {
      onChanged();
      toast({
        title: "Welcome message saved as draft ✍️",
        description: "Review and send it from the Campaigns tab whenever you're ready.",
      });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not save campaign",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (campaignCount > 0) {
    return (
      <StepDone title="Your first campaign is ready!" onContinue={onContinue}>
        <p className="text-sm text-muted-foreground">
          Review, edit and send campaigns from the Campaigns tab. Beyto keeps every send
          consent-first — guests who opted out are never contacted.
        </p>
      </StepDone>
    );
  }

  const simulated = providerMode.toUpperCase().includes("SIMULAT");
  const valid = name.trim().length >= 3 && message.trim().length >= 10 && !!defaultSegment;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold flex items-center gap-2">
          <MessageSquareText className="h-5 w-5 text-primary" /> Write your welcome message
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          A simple welcome message brings guests back. We save it as a <strong>draft</strong> —
          nothing is sent until you review and send it yourself.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && defaultSegment)
            createCampaign.mutate({
              name: name.trim(),
              segmentId: defaultSegment.id,
              channels: ["WHATSAPP"],
              messageTemplate: message.trim(),
              scheduleType: "NOW",
            });
        }}
        className="space-y-4 rounded-xl border p-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ob-camp-name">Campaign name</Label>
            <Input
              id="ob-camp-name"
              className="mt-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </div>
          <div>
            <Label>Audience</Label>
            <div className="mt-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              {segmentsQ.isLoading ? (
                "Loading segments…"
              ) : defaultSegment ? (
                <span className="flex items-center gap-2">
                  <Users2Icon /> {defaultSegment.name}
                  <Badge variant="outline" className="ml-auto">
                    {defaultSegment.memberCount} guests
                  </Badge>
                </span>
              ) : (
                "No segment available"
              )}
            </div>
          </div>
        </div>
        <div>
          <Label htmlFor="ob-camp-msg">Message (WhatsApp)</Label>
          <Textarea
            id="ob-camp-msg"
            className="mt-1.5 min-h-[110px]"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={1600}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1">{"{{name}}"}</code> is replaced with each
            guest's name automatically.
          </p>
        </div>

        {simulated && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
            <p className="font-semibold">WhatsApp is not connected yet</p>
            <p className="mt-0.5">
              Until you add your WhatsApp credentials, messages stay in simulation mode — great for
              testing, nothing real goes out.{" "}
              <button
                type="button"
                onClick={onGoIntegrations}
                className="font-semibold underline underline-offset-2"
              >
                Connect WhatsApp →
              </button>
            </p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2">
          <Button type="submit" className="flex-1" disabled={!valid || createCampaign.isPending}>
            {createCampaign.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Save as draft
          </Button>
          <Button type="button" variant="ghost" onClick={onContinue}>
            Skip
          </Button>
        </div>
      </form>
    </div>
  );
}

function Users2Icon() {
  return <UserPlus className="h-3.5 w-3.5 text-muted-foreground" />;
}

/* ------------------------------------------------------------------ */
/* Step 5 — Finish                                                     */
/* ------------------------------------------------------------------ */

function FinishStep({
  hotelName,
  done,
  setView,
  onFinish,
}: {
  hotelName: string;
  done: Record<"menu" | "qr" | "customer" | "campaign", boolean>;
  setView: (v: ViewId) => void;
  onFinish: () => void;
}) {
  const next: {
    label: string;
    desc: string;
    view: ViewId;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    {
      label: "Connect WhatsApp",
      desc: "Make your campaigns real — WhatsApp gets 10x more opens than SMS.",
      view: "integrations",
      icon: MessageSquareText,
    },
    {
      label: "Set up your loyalty program",
      desc: "Points per ₹100, rewards, tiers — guests keep coming back to earn.",
      view: "loyalty",
      icon: Gift,
    },
    {
      label: "Explore the POS & billing",
      desc: "GST bills, table orders and kitchen display — one system.",
      view: "pos",
      icon: ChefHat,
    },
  ];
  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <PartyPopper className="h-8 w-8 text-primary" />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-xl font-bold">{hotelName} is ready! 🚀</h3>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          {Object.values(done).filter(Boolean).length} of 4 setup tasks complete. Beyto is now
          working for you — every scan, visit and bill builds your repeat-customer base.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 text-left">
        {next.map((n) => (
          <button
            key={n.label}
            type="button"
            onClick={() => setView(n.view)}
            className="rounded-xl border p-4 text-left hover:bg-muted/50 transition-colors"
          >
            <n.icon className="h-5 w-5 text-primary" />
            <p className="mt-2 text-sm font-semibold">{n.label}</p>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{n.desc}</p>
          </button>
        ))}
      </div>

      <Button size="lg" onClick={onFinish}>
        Go to dashboard <Check className="h-4 w-4 ml-1.5" />
      </Button>
    </div>
  );
}
