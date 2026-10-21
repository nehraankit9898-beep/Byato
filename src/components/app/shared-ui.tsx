"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { formatNumber } from "@/lib/format";

/**
 * Shared display primitives — restyled for the "Ivory, Ink & Champagne"
 * direction. The public API is unchanged (tone, delay, action props all still
 * work), so the ~58 existing call sites keep compiling; only the visual
 * language moved from tinted cards to hairlines, serif numerals and one gold
 * accent.
 */

export function StatCard({
  title,
  value,
  hint,
  icon: Icon,
  tone = "default",
  delay = 0,
}: {
  title: string;
  value: number | string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "amber" | "emerald" | "rose" | "violet";
  delay?: number;
}) {
  // Tone now tints only the 14px icon — no coloured tiles, no coloured fills.
  const tones: Record<string, string> = {
    default: "text-foreground/55",
    amber: "text-[color:var(--gold-ink)]",
    emerald: "text-[color:var(--sage,#6f8574)]",
    rose: "text-[color:var(--destructive)]",
    violet: "text-muted-foreground",
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}
      className="lux-card p-5 transition-colors duration-[420ms] hover:border-[color:var(--gold)]/45"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {title}
          </p>
          <p className="mt-2.5 font-serif text-[30px] font-medium leading-none tabular-nums tracking-[-0.01em]">
            {typeof value === "number" ? formatNumber(value) : value}
          </p>
          {hint && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>
          )}
        </div>
        <Icon className={cn("h-[15px] w-[15px] shrink-0", tones[tone])} />
      </div>
    </motion.div>
  );
}

/** One cell of a KpiStrip. */
export type KpiItem = {
  label: string;
  value: number | string;
  hint?: string;
  /** Highlights the figure in ink (the number the owner should read first). */
  emphasis?: boolean;
};

/**
 * Hairline-divided KPI strip — the dashboard's primary numbers.
 *
 * Replaces four separate cards with a single ruled block: one shared border,
 * 1px internal rules (achieved with a background-coloured gap, which stays
 * crisp at every breakpoint), serif numerals and tabular figures.
 */
export function KpiStrip({ items, className }: { items: KpiItem[]; className?: string }) {
  return (
    <section
      aria-label="Restaurant summary"
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-[color:var(--border)] bg-[color:var(--border)] sm:grid-cols-4",
        className,
      )}
    >
      {items.map((item, i) => (
        <motion.div
          key={item.label}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.04 * i, duration: 0.5 }}
          className="bg-card px-5 py-4"
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {item.label}
          </p>
          <p
            className={cn(
              "mt-2 font-serif text-[30px] font-medium leading-none tabular-nums tracking-[-0.01em]",
              item.emphasis ? "text-[color:var(--gold-ink)]" : "text-foreground",
            )}
          >
            {typeof item.value === "number" ? formatNumber(item.value) : item.value}
          </p>
          {item.hint && (
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{item.hint}</p>
          )}
        </motion.div>
      ))}
    </section>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[6px] border border-dashed border-[color:var(--border)] bg-card/40 px-6 py-14 text-center">
      <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-[4px] border border-[color:var(--gold)]/35 text-[color:var(--gold-ink)]">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="font-serif text-[21px] font-medium leading-tight">{title}</h3>
      <p className="mt-2 max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  eyebrow,
  action,
}: {
  title: string;
  description?: string;
  /** Small uppercase gold label above the title. */
  eyebrow?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-[color:var(--border)] pb-4">
      <div>
        {eyebrow && <p className="lux-eyebrow">{eyebrow}</p>}
        <h2 className="mt-1.5 font-serif text-[23px] font-medium leading-tight tracking-[-0.01em]">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
