"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, SectionHeading, StatCard } from "@/components/app/shared-ui";
import { parseReportRecipients } from "@/lib/dashboard";
import { BarChart3, Mail } from "lucide-react";

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(minor / 100);

interface SalesReport {
  date: string;
  timezone: string;
  bills: {
    count: number;
    grossMinor: number;
    discountMinor: number;
    netSalesMinor: number;
    taxMinor: number;
    refundMinor: number;
  };
  payments: {
    byMethod: Record<string, number>;
    bySource: { gatewayVerified: number; manuallyRecorded: number };
  };
}
interface Schedule {
  frequency: "DAILY" | "WEEKLY";
  weekday: number | null;
  hour: number;
  recipients: string;
  active: boolean;
  lastSentAt: string | null;
  lastResult: string | null;
}

/** Phase 15 — owner reports + email digest schedule. */
export function ReportsView() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState("");
  // null means "use the value returned by the server". This keeps async query
  // data from being overwritten by the component's initial DAILY/empty state.
  const [recipients, setRecipients] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<Schedule["frequency"] | null>(null);

  const reportQ = useQuery({
    queryKey: ["sales-report", date],
    queryFn: async () =>
      (await api.get(`/api/reports/sales${date ? `?date=${date}` : ""}`)) as SalesReport,
  });
  const scheduleQ = useQuery({
    queryKey: ["report-schedule"],
    queryFn: async () => (await api.get("/api/report-schedule")) as { schedule: Schedule },
  });

  const saveSchedule = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await api.put("/api/report-schedule", patch)) as Record<string, unknown>,
    onSuccess: () => {
      toast.success("Report schedule saved.");
      queryClient.invalidateQueries({ queryKey: ["report-schedule"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const schedule = scheduleQ.data?.schedule;
  const selectedFrequency = frequency ?? schedule?.frequency ?? "DAILY";
  const storedRecipients = parseReportRecipients(schedule?.recipients);
  const recipientValue = recipients ?? storedRecipients.join(", ");
  const recipientList = (recipients ?? storedRecipients.join(", "))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const r = reportQ.data;

  function saveSchedulePatch(active: boolean) {
    if (!schedule) return;
    saveSchedule.mutate({
      frequency: selectedFrequency,
      weekday: schedule.weekday ?? 1,
      hour: schedule.hour,
      recipients: recipientList,
      active,
    });
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Owner reports"
        description="Business-day figures reconcile against invoices, payment allocations and refunds — tenant timezone aware."
        action={
          <Input
            type="date"
            className="w-44"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Report date"
          />
        }
      />

      {reportQ.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : reportQ.isError || !r ? (
        <EmptyState
          icon={BarChart3}
          title="Couldn't load owner report"
          description="The sales report could not be fetched. No zero values are shown because the result is unknown."
          action={
            <Button onClick={() => reportQ.refetch()} disabled={reportQ.isFetching}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard title="Bills" value={r.bills.count} icon={BarChart3} />
            <StatCard
              title="Net sales"
              value={rupees(r.bills.netSalesMinor)}
              icon={BarChart3}
              tone="emerald"
            />
            <StatCard
              title="Tax collected"
              value={rupees(r.bills.taxMinor)}
              icon={BarChart3}
              tone="amber"
            />
            <StatCard
              title="Refunds"
              value={rupees(r.bills.refundMinor)}
              icon={BarChart3}
              tone="rose"
            />
          </div>

          <Card>
            <CardContent className="p-4 space-y-2 text-sm">
              <div className="font-semibold">Payment modes ({r.timezone})</div>
              {Object.entries(r.payments.byMethod).length === 0 ? (
                <p className="text-muted-foreground">
                  No payments recorded for this business day yet.
                </p>
              ) : (
                Object.entries(r.payments.byMethod).map(([method, amount]) => (
                  <div key={method} className="flex justify-between border-b py-1">
                    <span>{method}</span>
                    <span>{rupees(amount)}</span>
                  </div>
                ))
              )}
              <p className="text-xs text-muted-foreground">
                {r.payments.bySource.gatewayVerified} gateway-verified ·{" "}
                {r.payments.bySource.manuallyRecorded} manually recorded
              </p>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="font-semibold text-sm flex items-center gap-2">
            <Mail className="h-4 w-4" /> Email digest
          </div>
          {scheduleQ.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : scheduleQ.isError ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
              role="alert"
            >
              <span>Could not load the email digest settings.</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => scheduleQ.refetch()}
                disabled={scheduleQ.isFetching}
              >
                Try again
              </Button>
            </div>
          ) : schedule ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Switch
                checked={schedule.active}
                onCheckedChange={(active) => saveSchedulePatch(active)}
                disabled={saveSchedule.isPending}
                aria-label="Enable email digest"
              />
              <Select
                value={selectedFrequency}
                onValueChange={(value) => setFrequency(value as Schedule["frequency"])}
              >
                <SelectTrigger className="w-32" aria-label="Digest frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DAILY">Daily</SelectItem>
                  <SelectItem value="WEEKLY">Weekly</SelectItem>
                </SelectContent>
              </Select>
              <Input
                className="flex-1 min-w-64"
                placeholder="owner@example.com, manager@example.com"
                value={recipientValue}
                onChange={(e) => setRecipients(e.target.value)}
                aria-label="Digest recipients"
              />
              <Button disabled={saveSchedule.isPending} onClick={() => saveSchedulePatch(true)}>
                Save
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {schedule?.lastResult
              ? `Last send: ${schedule.lastResult}`
              : "Digest emails fire when email transport is configured (Integrations)."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
