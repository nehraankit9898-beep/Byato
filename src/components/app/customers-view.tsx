"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { CustomersResponse, CustomerRow, ViewId, SessionUser } from "@/lib/types";
import { CustomerDialog } from "./customer-dialog";
import { VisitDialog } from "./visit-dialog";
import { EmptyState } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Search,
  UserPlus,
  MoreHorizontal,
  Eye,
  EyeOff,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  CalendarCheck,
  Pencil,
  UserRoundX,
  UserRoundCheck,
  BellRing,
  BellOff,
  Users,
  Loader2,
  Crown,
  Download,
  UserCheck,
  Clock3,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDate, initials, maskPhoneDisplay, phoneDisplay, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Download the customers CSV export. Handles both flows from
 * GET /api/export/customers: inline CSV (≤5000 rows) and the async job
 * flow (202 + jobId → poll → signed download token).
 */
async function triggerCustomersExport(): Promise<void> {
  const token = (() => {
    try {
      return localStorage.getItem("stayloop_session_token");
    } catch {
      return null;
    }
  })();
  const res = await fetch("/api/export/customers", {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (res.status === 202) {
    // Async export: poll the job until COMPLETED, then download via token.
    const queued = (await res.json()) as { jobId: string; message?: string };
    const jobId = queued.jobId;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const jobRes = await fetch(`/api/jobs/${jobId}`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!jobRes.ok) throw new Error("The export job could not be tracked. Please try again.");
      const data = (await jobRes.json()) as {
        job?: { status: string; result?: { downloadToken?: string; filename?: string } };
        status?: string;
        result?: { downloadToken?: string; filename?: string };
      };
      const job = data.job ?? { status: data.status ?? "", result: data.result };
      if (job.status === "COMPLETED" && job.result?.downloadToken) {
        window.open(
          `/api/jobs/${jobId}/download?token=${encodeURIComponent(job.result.downloadToken)}`,
          "_blank",
        );
        return;
      }
      if (job.status === "FAILED")
        throw new Error("The export failed on the server. Please try again.");
    }
    throw new Error(
      "The export is taking longer than expected. Check Audit Logs or retry in a minute.",
    );
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(data?.error?.message || "Export failed. Please try again.");
  }

  // Inline CSV — hand it to the browser as a file download.
  const csv = await res.text();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

type SortField = "created" | "name" | "visits" | "last_visit";
type ActivityFilter = "all" | "new" | "returning" | "lapsed" | "never";

function SortIcon({
  field,
  sort,
  order,
}: {
  field: SortField;
  sort: SortField;
  order: "asc" | "desc";
}) {
  if (sort !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
  return order === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
}

/**
 * Client-side visibility helper. Hiding is UX only — every route re-checks the
 * permission server-side. When the session payload does not carry a permission
 * set (older caches) we do NOT hide the control: the server remains the guard.
 */
function can(user: SessionUser | null | undefined, permission: string): boolean {
  if (!user?.permissions) return true;
  return user.permissions.includes(permission);
}

export function CustomersView({
  onOpenCustomer,
  setView,
  user,
}: {
  onOpenCustomer: (id: string) => void;
  setView: (v: ViewId) => void;
  user?: SessionUser | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // --- Filters state ---
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [consent, setConsent] = useState("all");
  const [status, setStatus] = useState("all");
  const [activity, setActivity] = useState<ActivityFilter>("all");
  const [sort, setSort] = useState<SortField>("created");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [showPhones, setShowPhones] = useState(false);

  // --- Dialogs ---
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [visitFor, setVisitFor] = useState<CustomerRow | null>(null);
  const [visitOpen, setVisitOpen] = useState(false);
  const [deactivating, setDeactivating] = useState<CustomerRow | null>(null);
  const [consentAction, setConsentAction] = useState<{
    customer: CustomerRow;
    mode: "opt_in" | "opt_out";
  } | null>(null);
  const [exporting, setExporting] = useState(false);

  // Permissions (server-authoritative; used only to hide controls)
  const canCreate = can(user, "CUSTOMER_CREATE");
  const canUpdate = can(user, "CUSTOMER_UPDATE");
  const canDelete = can(user, "CUSTOMER_DELETE");
  const canExport = can(user, "CUSTOMER_READ");

  // Debounce search
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 350);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [searchInput]);

  const queryKey = useMemo(
    () =>
      ["customers", { search, consent, status, activity, sort, order, page, pageSize }] as const,
    [search, consent, status, activity, sort, order, page, pageSize],
  );

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({
        q: search,
        consent,
        status,
        activity,
        sort,
        order,
        page: String(page),
        pageSize: String(pageSize),
      });
      return api.get<CustomersResponse>(`/api/customers?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  // Filter/sort changes always return to page 1 (event handlers, not effects)
  function changeConsent(v: string) {
    setConsent(v);
    setPage(1);
  }
  function changeStatus(v: string) {
    setStatus(v);
    setPage(1);
  }
  function changeActivity(v: ActivityFilter) {
    setActivity(v);
    setPage(1);
  }
  function clearFilters() {
    setSearchInput("");
    setConsent("all");
    setStatus("all");
    setActivity("all");
    setPage(1);
  }

  function toggleSort(field: SortField) {
    if (sort === field) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setOrder(field === "name" ? "asc" : "desc");
    }
    setPage(1);
  }

  // Mutations
  const deactivateMutation = useMutation({
    mutationFn: (c: CustomerRow) => api.delete(`/api/customers/${c.id}`),
    onSuccess: (_, c) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({ title: "Customer deactivated", description: `${c.name} is now marked inactive.` });
      setDeactivating(null);
    },
    onError: (err) => {
      toast({
        title: "Could not deactivate",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (c: CustomerRow) => api.patch(`/api/customers/${c.id}`, { status: "ACTIVE" }),
    onSuccess: (_, c) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({ title: "Customer reactivated", description: `${c.name} is active again.` });
    },
    onError: (err) => {
      toast({
        title: "Could not reactivate",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const consentMutation = useMutation({
    mutationFn: ({ customer, mode }: { customer: CustomerRow; mode: "opt_in" | "opt_out" }) =>
      api.post(`/api/customers/${customer.id}/${mode === "opt_in" ? "consent" : "opt-out"}`),
    onSuccess: (_, { customer, mode }) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({
        title: mode === "opt_in" ? "Consent recorded" : "Opt-out recorded",
        description:
          mode === "opt_in"
            ? `${customer.name} agreed to receive marketing offers.`
            : `${customer.name} will not receive marketing messages.`,
      });
      setConsentAction(null);
    },
    onError: (err) => {
      toast({
        title: "Could not update consent",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const summary = data?.summary;
  const filtersActive = !!search || consent !== "all" || status !== "all" || activity !== "all";

  return (
    <div className="space-y-4">
      {/* Summary cards — real counts computed server-side from this tenant's rows */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {isLoading && !summary ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))
        ) : (
          <>
            <SummaryTile
              icon={Users}
              title="Total customers"
              value={summary?.total ?? 0}
              hint="Everyone in your list"
              active={activity === "all"}
              onClick={() => changeActivity("all")}
            />
            <SummaryTile
              icon={UserPlus}
              title="New customers"
              value={summary?.newCustomers ?? 0}
              hint={`First visit in the last ${summary?.newWindowDays ?? 30} days`}
              active={activity === "new"}
              onClick={() => changeActivity("new")}
            />
            <SummaryTile
              icon={UserCheck}
              title="Returning customers"
              value={summary?.returningCustomers ?? 0}
              hint="2 or more visits/orders"
              active={activity === "returning"}
              onClick={() => changeActivity("returning")}
            />
            <SummaryTile
              icon={Clock3}
              title="Not visited recently"
              value={summary?.lapsedCustomers ?? 0}
              hint={`No visit in ${summary?.lapsedWindowDays ?? 90} days · ${summary?.neverVisited ?? 0} never visited`}
              active={activity === "lapsed"}
              onClick={() => changeActivity("lapsed")}
            />
          </>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or mobile number…"
            className="pl-10"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search customers by name or mobile number"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={activity} onValueChange={(v) => changeActivity(v as ActivityFilter)}>
            <SelectTrigger className="w-[150px]" aria-label="Filter by visit activity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All activity</SelectItem>
              <SelectItem value="new">New customers</SelectItem>
              <SelectItem value="returning">Returning</SelectItem>
              <SelectItem value="lapsed">Not visited recently</SelectItem>
              <SelectItem value="never">Never visited</SelectItem>
            </SelectContent>
          </Select>
          <Select value={consent} onValueChange={changeConsent}>
            <SelectTrigger className="w-[150px]" aria-label="Filter by consent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All consent</SelectItem>
              <SelectItem value="opted_in">Opted in</SelectItem>
              <SelectItem value="opted_out">Opted out</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={changeStatus}>
            <SelectTrigger className="w-[130px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowPhones((s) => !s)}
            aria-label={showPhones ? "Hide phone numbers" : "Show phone numbers"}
            title={showPhones ? "Hide phone numbers" : "Show phone numbers"}
          >
            {showPhones ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          {canExport && (
            <Button
              variant="outline"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  await triggerCustomersExport();
                  toast({
                    title: "Export ready",
                    description: "Your customer CSV download has started.",
                  });
                } catch (err) {
                  toast({
                    title: "Export failed",
                    description: err instanceof Error ? err.message : "Please try again.",
                    variant: "destructive",
                  });
                } finally {
                  setExporting(false);
                }
              }}
              aria-label="Export customers to CSV"
              title="Export all customers to CSV"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">Export</span>
            </Button>
          )}
          {canCreate && (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <UserPlus className="h-4 w-4" /> Add customer
            </Button>
          )}
        </div>
      </div>

      {/* Result count */}
      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <p>
          {total > 0 ? (
            <>
              Showing{" "}
              <span className="font-semibold text-foreground">
                {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}
              </span>{" "}
              of <span className="font-semibold text-foreground">{formatNumber(total)}</span>{" "}
              {total === 1 ? "customer" : "customers"}
            </>
          ) : (
            "No customers to show"
          )}
          {isFetching && !isLoading && <Loader2 className="inline ml-2 h-3 w-3 animate-spin" />}
        </p>
        {filtersActive && (
          <button
            className="hover:text-foreground underline underline-offset-2"
            onClick={clearFilters}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Loading / error / empty / list */}
      {isLoading ? (
        <div className="rounded-xl border bg-card">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b last:border-0 px-4 py-3.5">
              <Skeleton className="h-9 w-9 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-28 ml-auto" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Users}
          title="Couldn't load customers"
          description="Something went wrong while fetching your customer list."
          action={
            <Button onClick={() => refetch()}>
              <Loader2 className="h-4 w-4" /> Try again
            </Button>
          }
        />
      ) : customers.length === 0 ? (
        <EmptyState
          icon={filtersActive ? Search : Users}
          title={filtersActive ? "No matching customers" : "No customers yet"}
          description={
            filtersActive
              ? "Try a different name or number, or clear the filters to see everyone."
              : "Add your first customer manually, or import your whole list from a CSV file."
          }
          action={
            filtersActive ? (
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <div className="flex flex-wrap justify-center gap-2">
                {canCreate && (
                  <Button
                    onClick={() => {
                      setEditing(null);
                      setDialogOpen(true);
                    }}
                  >
                    <UserPlus className="h-4 w-4" /> Add customer
                  </Button>
                )}
                <Button variant="outline" onClick={() => setView("import")}>
                  Import CSV
                </Button>
              </div>
            )
          }
        />
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          {/* Mobile / tablet: card list */}
          <ul className="divide-y md:hidden">
            {customers.map((c) => (
              <li key={c.id}>
                <button
                  className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-accent/40 transition-colors"
                  onClick={() => onOpenCustomer(c.id)}
                >
                  <Avatar className="h-10 w-10 shrink-0">
                    <AvatarFallback
                      className={cn(
                        "text-[11px] font-bold",
                        c.status === "ACTIVE"
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {initials(c.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-[14px] flex items-center gap-1">
                      {c.name}
                      {c.vip && <Crown className="h-3 w-3 text-amber-500" aria-label="VIP" />}
                    </p>
                    <p className="text-[12px] text-muted-foreground font-mono">
                      {showPhones ? phoneDisplay(c.phone) : maskPhoneDisplay(c.phone)}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary" className="tabular-nums text-[10.5px]">
                        {c.totalVisits} {c.totalVisits === 1 ? "visit" : "visits"}
                      </Badge>
                      {c.isReturning && (
                        <Badge
                          variant="secondary"
                          className="bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-0 text-[10.5px]"
                        >
                          Returning
                        </Badge>
                      )}
                      {c.neverVisited && (
                        <Badge variant="outline" className="text-[10.5px] text-muted-foreground">
                          No visits yet
                        </Badge>
                      )}
                      {c.optOut ? (
                        <Badge className="bg-rose-500/12 text-rose-600 dark:text-rose-400 border-0 text-[10.5px]">
                          Opted out
                        </Badge>
                      ) : c.marketingConsent ? (
                        <Badge className="bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-0 text-[10.5px]">
                          Opted in
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Last visit {formatDate(c.lastVisit)}
                      {c.totalSpend != null && c.totalSpend > 0
                        ? ` · ₹${c.totalSpend.toLocaleString("en-IN")}`
                        : ""}
                    </p>
                  </div>
                </button>
                {(canUpdate || canDelete) && (
                  <div className="flex justify-end px-3 pb-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Actions for ${c.name}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <CustomerMenuItems
                          c={c}
                          canUpdate={canUpdate}
                          canDelete={canDelete}
                          onOpenCustomer={onOpenCustomer}
                          onEdit={() => {
                            setEditing(c);
                            setDialogOpen(true);
                          }}
                          onAddVisit={() => {
                            setVisitFor(c);
                            setVisitOpen(true);
                          }}
                          onConsent={(mode) => setConsentAction({ customer: c, mode })}
                          onDeactivate={() => setDeactivating(c)}
                          onReactivate={() => reactivateMutation.mutate(c)}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="hidden md:block overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-accent/40 hover:bg-accent/40">
                  <TableHead className="w-[40px]"></TableHead>
                  <TableHead>
                    <button
                      className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors font-semibold"
                      onClick={() => toggleSort("name")}
                    >
                      Customer <SortIcon field="name" sort={sort} order={order} />
                    </button>
                  </TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead className="hidden lg:table-cell">Email</TableHead>
                  <TableHead>
                    <button
                      className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors font-semibold"
                      onClick={() => toggleSort("visits")}
                    >
                      Visits <SortIcon field="visits" sort={sort} order={order} />
                    </button>
                  </TableHead>
                  <TableHead className="hidden sm:table-cell">
                    <button
                      className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors font-semibold"
                      onClick={() => toggleSort("last_visit")}
                    >
                      Last visit <SortIcon field="last_visit" sort={sort} order={order} />
                    </button>
                  </TableHead>
                  <TableHead>Consent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden xl:table-cell">Spend</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => onOpenCustomer(c.id)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Avatar className="h-9 w-9">
                        <AvatarFallback
                          className={cn(
                            "text-[11px] font-bold",
                            c.status === "ACTIVE"
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {initials(c.name)}
                        </AvatarFallback>
                      </Avatar>
                    </TableCell>
                    <TableCell className="max-w-[180px]">
                      <p className="truncate font-semibold text-[13.5px] flex items-center gap-1">
                        {c.name}
                        {c.vip && <Crown className="h-3 w-3 text-amber-500" aria-label="VIP" />}
                      </p>
                      {c.isReturning && (
                        <p className="text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                          Returning
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[12.5px] text-muted-foreground">
                      {showPhones ? phoneDisplay(c.phone) : maskPhoneDisplay(c.phone)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell max-w-[170px]">
                      <p className="truncate text-[12.5px] text-muted-foreground">
                        {c.email || "—"}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "tabular-nums font-semibold",
                          c.totalVisits >= 3 &&
                            "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
                          c.totalVisits === 0 && "bg-muted text-muted-foreground",
                        )}
                      >
                        {c.totalVisits}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-[12.5px] text-muted-foreground">
                      {formatDate(c.lastVisit)}
                    </TableCell>
                    <TableCell>
                      {c.optOut ? (
                        <Badge className="bg-rose-500/12 text-rose-600 dark:text-rose-400 hover:bg-rose-500/12 border-0">
                          <BellOff className="h-3 w-3 mr-1" /> Opted out
                        </Badge>
                      ) : c.marketingConsent ? (
                        <Badge className="bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/12 border-0">
                          <BellRing className="h-3 w-3 mr-1" /> Opted in
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-muted-foreground">
                          No consent
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          c.status === "ACTIVE"
                            ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5"
                            : "border-muted-foreground/30 text-muted-foreground",
                        )}
                      >
                        {c.status === "ACTIVE" ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-[12.5px] tabular-nums font-medium">
                      {c.totalSpend != null && c.totalSpend > 0
                        ? `₹${c.totalSpend.toLocaleString("en-IN")}`
                        : "—"}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {(canUpdate || canDelete) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={`Actions for ${c.name}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <CustomerMenuItems
                              c={c}
                              canUpdate={canUpdate}
                              canDelete={canDelete}
                              onOpenCustomer={onOpenCustomer}
                              onEdit={() => {
                                setEditing(c);
                                setDialogOpen(true);
                              }}
                              onAddVisit={() => {
                                setVisitFor(c);
                                setVisitOpen(true);
                              }}
                              onConsent={(mode) => setConsentAction({ customer: c, mode })}
                              onDeactivate={() => setDeactivating(c)}
                              onReactivate={() => reactivateMutation.mutate(c)}
                            />
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-accent/20 px-4 py-3">
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Page <span className="font-semibold text-foreground">{page}</span> of {totalPages}
              </p>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v));
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-7 w-[92px] text-xs" aria-label="Rows per page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 / page</SelectItem>
                  <SelectItem value="25">25 / page</SelectItem>
                  <SelectItem value="50">50 / page</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <ChevronLeft className="h-4 w-4" /> Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <CustomerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onOpenCustomer={onOpenCustomer}
      />
      <VisitDialog open={visitOpen} onOpenChange={setVisitOpen} presetCustomer={visitFor} />

      {/* Deactivate confirm */}
      <AlertDialog open={!!deactivating} onOpenChange={(o) => !o && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivating?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The customer will be hidden from your active list and excluded from future campaigns.
              Their visits and history are kept. You can reactivate anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deactivating && deactivateMutation.mutate(deactivating)}
            >
              {deactivateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Yes, deactivate"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Consent confirm */}
      <AlertDialog open={!!consentAction} onOpenChange={(o) => !o && setConsentAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {consentAction?.mode === "opt_in"
                ? `Record marketing consent for ${consentAction?.customer.name}?`
                : `Opt ${consentAction?.customer.name} out of marketing?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {consentAction?.mode === "opt_in"
                ? "Confirm that this customer has agreed to receive promotional offers and updates from your restaurant."
                : "The customer will stop receiving all promotional messages. Their consent flag will be cleared and opt-out recorded."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={consentMutation.isPending}
              onClick={() => consentAction && consentMutation.mutate(consentAction)}
            >
              {consentMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : consentAction?.mode === "opt_in" ? (
                "Yes, record consent"
              ) : (
                "Yes, opt out"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One summary card; clicking it applies the matching activity filter. */
function SummaryTile({
  icon,
  title,
  value,
  hint,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: number;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "text-left rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40",
        active && "ring-2 ring-primary/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium text-muted-foreground leading-tight">{title}</p>
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
      <p className="mt-1.5 text-[24px] font-bold tracking-tight leading-none tabular-nums">
        {formatNumber(value)}
      </p>
      <p className="mt-1.5 text-[11px] text-muted-foreground leading-snug">{hint}</p>
    </button>
  );
}

/** Row action menu — shared by the desktop table and the mobile card list. */
function CustomerMenuItems({
  c,
  canUpdate,
  canDelete,
  onOpenCustomer,
  onEdit,
  onAddVisit,
  onConsent,
  onDeactivate,
  onReactivate,
}: {
  c: CustomerRow;
  canUpdate: boolean;
  canDelete: boolean;
  onOpenCustomer: (id: string) => void;
  onEdit: () => void;
  onAddVisit: () => void;
  onConsent: (mode: "opt_in" | "opt_out") => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  return (
    <>
      <DropdownMenuLabel className="text-xs">{c.name}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onOpenCustomer(c.id)}>
        <Eye className="h-4 w-4" /> View profile
      </DropdownMenuItem>
      {canUpdate && (
        <>
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="h-4 w-4" /> Edit details
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onAddVisit}>
            <CalendarCheck className="h-4 w-4" /> Record visit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {c.optOut || !c.marketingConsent ? (
            <DropdownMenuItem onClick={() => onConsent("opt_in")}>
              <BellRing className="h-4 w-4" /> Record marketing consent
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => onConsent("opt_out")}>
              <BellOff className="h-4 w-4" /> Opt out of marketing
            </DropdownMenuItem>
          )}
        </>
      )}
      {canDelete && (
        <>
          <DropdownMenuSeparator />
          {c.status === "ACTIVE" ? (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDeactivate}
            >
              <UserRoundX className="h-4 w-4" /> Deactivate customer
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={onReactivate}>
              <UserRoundCheck className="h-4 w-4" /> Reactivate customer
            </DropdownMenuItem>
          )}
        </>
      )}
    </>
  );
}
