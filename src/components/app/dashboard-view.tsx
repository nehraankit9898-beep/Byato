"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DashboardData, SessionUser, ViewId } from "@/lib/types";
import { KpiStrip, EmptyState } from "./shared-ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { formatDateKey, formatRelative, formatNumber } from "@/lib/format";
import type { SubscriptionView } from "@/lib/types";
import {
  CalendarCheck,
  ArrowRight,
  UserPlus,
  TrendingUp,
  Loader2,
  Clock,
  AlertTriangle,
} from "lucide-react";

const chartConfig = {
  visits: { label: "Visits", color: "var(--chart-1)" },
} satisfies ChartConfig;

const consentConfig = {
  optedIn: { label: "Opted in", color: "var(--chart-2)" },
  noConsent: { label: "No consent yet", color: "var(--chart-3)" },
  optedOut: { label: "Opted out", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function DashboardView({
  user,
  setView,
  onOpenCustomer,
}: {
  user: SessionUser;
  setView: (v: ViewId) => void;
  onOpenCustomer: (id: string) => void;
}) {
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/api/dashboard/stats"),
    refetchInterval: 60_000, // dashboard stays fresh
  });

  // Phase 10 — trial/expiry banner (server-verified subscription state).
  const subscriptionQuery = useQuery({
    queryKey: ["subscription", "self"],
    queryFn: () => api.get<{ subscription: SubscriptionView }>("/api/subscription"),
    retry: false,
  });
  const subscription = subscriptionQuery.data?.subscription;
  const showTrialBanner =
    subscription?.state === "TRIALING" && (subscription.trialDaysRemaining ?? 0) <= 7;
  const showExpiryBanner = subscription?.state === "GRACE" || subscription?.state === "EXPIRED";

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-[6px]" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-[300px] rounded-[6px] lg:col-span-2" />
          <Skeleton className="h-[300px] rounded-[6px]" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="Could not load your dashboard"
        description="We couldn't fetch your statistics right now. This is usually temporary."
        action={
          <Button onClick={() => refetch()} disabled={isRefetching}>
            {isRefetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Try again
          </Button>
        }
      />
    );
  }

  const { stats, visitsTrend, recentCustomers, recentVisits } = data;
  const consentData = [
    { key: "optedIn", label: "Opted in", value: stats.marketingOptIn },
    { key: "noConsent", label: "No consent yet", value: stats.noConsent },
    { key: "optedOut", label: "Opted out", value: stats.optedOut },
  ].filter((d) => d.value > 0);

  // Merge recent activity
  const activity = [
    ...recentCustomers.map((c) => ({
      kind: "customer" as const,
      id: c.id,
      name: c.name,
      detail: "New customer added",
      at: c.createdAt,
    })),
    ...recentVisits.map((v) => ({
      kind: "visit" as const,
      id: v.customer.id,
      name: v.customer.name,
      detail: "Visit recorded",
      at: v.createdAt,
    })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 8);

  const trendChartData = visitsTrend.map((d) => ({
    date: formatDateKey(d.date),
    visits: d.count,
  }));

  return (
    <div className="space-y-6">
      {/* Phase 10 — trial / expiry banner (server-verified, never client-trusted) */}
      {showTrialBanner && (
        <div className="flex flex-wrap items-center gap-4 rounded-[6px] border border-[color:var(--border)] border-l-2 border-l-[color:var(--gold)] bg-card px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--gold)]/35 text-[color:var(--gold-ink)]">
            <Clock className="h-[15px] w-[15px]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-serif text-[18px] font-medium leading-tight">
              Trial ending in {subscription?.trialDaysRemaining}{" "}
              {subscription?.trialDaysRemaining === 1 ? "day" : "days"}
              {subscription?.plan ? ` — ${subscription.plan.name} plan` : ""}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              Keep your campaigns, loyalty program and guest insights after the trial — pick a plan
              in Billing.
            </p>
          </div>
          <Button
            size="sm"
            className="uppercase tracking-[0.12em]"
            onClick={() => setView("billing")}
          >
            Upgrade plan
          </Button>
        </div>
      )}
      {showExpiryBanner && (
        <div className="flex flex-wrap items-center gap-4 rounded-[6px] border border-[color:var(--border)] border-l-2 border-l-[color:var(--destructive)] bg-card px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--destructive)]/35 text-[color:var(--destructive)]">
            <AlertTriangle className="h-[15px] w-[15px]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-serif text-[18px] font-medium leading-tight">
              {subscription?.state === "GRACE"
                ? "Grace period — renew now"
                : "Your subscription has expired"}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              {subscription?.state === "GRACE"
                ? `Access continues until ${subscription?.graceEndsAt ? new Date(subscription.graceEndsAt).toLocaleDateString() : "the grace window ends"}.`
                : "Choose a plan to restore full access to your workspace."}
            </p>
          </div>
          <Button size="sm" onClick={() => setView("billing")}>
            View plans
          </Button>
        </div>
      )}
      {/* Welcome strip: explain the page and make the two common actions obvious. */}
      <section className="lux-sheen rounded-[6px] border border-[color:var(--border)] px-5 py-6 sm:px-7 sm:py-7">
        <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <p className="lux-eyebrow">{user.hotelName}</p>
            <h2 className="mt-2 font-serif text-[27px] font-medium leading-tight tracking-[-0.012em]">
              Good to see you, {user.name.split(" ")[0]}
            </h2>
            <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
              Here is your restaurant&apos;s guest activity for today.
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              className="w-full uppercase tracking-[0.12em] sm:w-auto"
              onClick={() => setView("customers")}
            >
              Add customer
            </Button>
            <Button
              className="w-full uppercase tracking-[0.12em] sm:w-auto"
              variant="outline"
              onClick={() => setView("visits")}
            >
              Record a visit
            </Button>
          </div>
        </div>
      </section>

      {/* Four owner-friendly numbers; detailed consent breakdown stays in the chart below. */}
      <KpiStrip
        items={[
          { label: "Customers", value: stats.totalCustomers, hint: "Active records" },
          {
            label: "Repeat customers",
            value: stats.repeatCustomers,
            hint: `${stats.repeatRate}% have returned`,
            emphasis: true,
          },
          { label: "Visits recorded", value: stats.totalVisits, hint: "All recorded visits" },
          {
            label: "Can receive offers",
            value: stats.marketingOptIn,
            hint: `${pct(stats.marketingOptIn, stats.totalCustomers)}% opted in`,
          },
        ]}
      />

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">
              Visits
              <span className="font-sans text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Last 14 days
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {trendChartData.every((d) => d.visits === 0) && trendChartData.length > 0 ? (
              <div className="flex flex-col items-center justify-center h-[220px] text-center">
                <p className="text-sm text-muted-foreground">
                  No visits recorded in the last 14 days.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => setView("visits")}
                >
                  Record a visit
                </Button>
              </div>
            ) : (
              <ChartContainer config={chartConfig} className="h-[220px] w-full">
                <AreaChart data={trendChartData} margin={{ left: -18, right: 8, top: 6 }}>
                  <defs>
                    <linearGradient id="fillVisits" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-visits)" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="var(--color-visits)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    vertical={false}
                    strokeDasharray="2 5"
                    stroke="var(--border)"
                    opacity={0.7}
                  />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={34}
                  />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  <Area
                    dataKey="visits"
                    type="monotone"
                    stroke="var(--color-visits)"
                    strokeWidth={1.75}
                    fill="url(#fillVisits)"
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">
              Consent
              <span className="font-sans text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Opt-in split
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {consentData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[220px] text-center">
                <p className="text-sm text-muted-foreground">No customers yet.</p>
              </div>
            ) : (
              <div className="relative h-[220px]">
                <ChartContainer config={consentConfig} className="h-[220px] w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
                    <Pie
                      data={consentData}
                      dataKey="value"
                      nameKey="label"
                      innerRadius={56}
                      outerRadius={84}
                      paddingAngle={2}
                      strokeWidth={1}
                    >
                      {consentData.map((entry) => (
                        <Cell
                          key={entry.key}
                          fill={`var(--color-${entry.key})`}
                          stroke="var(--background)"
                        />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <p className="font-serif text-[30px] font-medium tabular-nums leading-none">
                    {pct(stats.marketingOptIn, stats.totalCustomers)}%
                  </p>
                  <p className="mt-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    opted in
                  </p>
                </div>
              </div>
            )}
            <div className="mt-2 space-y-2">
              {consentData.map((d) => (
                <div key={d.key} className="flex items-center gap-2 text-xs">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: `var(--color-${d.key})` }}
                  />
                  <span className="flex-1 text-muted-foreground">{d.label}</span>
                  <span className="font-semibold tabular-nums">{formatNumber(d.value)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {activity.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                icon={CalendarCheck}
                title="No activity yet"
                description="Add your first customer or record a visit — it will show up here instantly."
                action={
                  <Button size="sm" onClick={() => setView("customers")}>
                    <UserPlus className="h-4 w-4" /> Add customer
                  </Button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y">
              {activity.map((a, i) => (
                <li key={`${a.kind}-${a.id}-${i}`}>
                  <button
                    type="button"
                    onClick={() => onOpenCustomer(a.id)}
                    className="flex w-full items-center gap-3.5 px-6 py-4 text-left transition-colors duration-[420ms] hover:bg-[color:var(--porcelain)]"
                  >
                    <div
                      className={
                        a.kind === "visit"
                          ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--gold)]/35 text-[color:var(--gold-ink)]"
                          : "flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--border)] text-muted-foreground"
                      }
                    >
                      {a.kind === "visit" ? (
                        <CalendarCheck className="h-[14px] w-[14px]" />
                      ) : (
                        <UserPlus className="h-[14px] w-[14px]" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">
                        {a.name}
                        <span className="ml-2 font-normal text-muted-foreground">{a.detail}</span>
                      </p>
                      <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                        {formatRelative(a.at)}
                      </p>
                    </div>
                    {a.kind === "customer" && (
                      <Badge variant="secondary" className="hidden sm:inline-flex text-[10.5px]">
                        Customer
                      </Badge>
                    )}
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/40" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function pct(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}
