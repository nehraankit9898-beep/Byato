import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "placeholder:text-muted-foreground/70 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-20 w-full rounded-[4px] border border-[color:var(--border)] bg-white/60 px-3 py-2 text-[13.5px] shadow-none transition-[color,box-shadow] duration-[420ms] outline-none focus-visible:border-[color:var(--gold)] focus-visible:ring-1 focus-visible:ring-[color:var(--gold)] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
