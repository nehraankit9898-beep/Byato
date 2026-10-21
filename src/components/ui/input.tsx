import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-[color:var(--gold-soft)] selection:text-foreground dark:bg-input/30 flex h-10 w-full min-w-0 rounded-[4px] border border-[color:var(--border)] bg-white/60 px-3 py-1 text-[13.5px] shadow-none transition-[color,box-shadow] duration-[420ms] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-[color:var(--gold)] focus-visible:ring-1 focus-visible:ring-[color:var(--gold)] focus-visible:ring-offset-0",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
