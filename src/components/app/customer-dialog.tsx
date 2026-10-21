"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { CustomerRow } from "@/lib/types";
import { customerCreateSchema, parseWithFieldErrors } from "@/lib/validation";
import { normalizePhone } from "@/lib/phone";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, UserPlus, Pencil, Info, Sparkles, ChevronDown, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * Add / Edit customer dialog.
 *
 * UX contract:
 *  - validation runs on the client FIRST (instant, field-level messages) and
 *    again on the server (authoritative — the client is never trusted);
 *  - a submit that is already in flight cannot be started again, so a double
 *    click or a double Enter can never create two customers;
 *  - entered values are preserved whenever validation fails (the dialog only
 *    closes on success or on an explicit Cancel);
 *  - a duplicate phone number is never silently created: the server returns the
 *    EXISTING customer and the form offers to open that profile instead.
 */
export function CustomerDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
  onOpenCustomer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: CustomerRow | null;
  onSaved?: (customer: CustomerRow) => void;
  /** Used by the duplicate flow: open the existing profile instead of creating. */
  onOpenCustomer?: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto">
        <CustomerForm
          editing={editing ?? null}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
          onOpenCustomer={onOpenCustomer}
        />
      </DialogContent>
    </Dialog>
  );
}

interface FieldErrors {
  [field: string]: string | undefined;
}

function CustomerForm({
  editing,
  onOpenChange,
  onSaved,
  onOpenCustomer,
}: {
  editing: CustomerRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (customer: CustomerRow) => void;
  onOpenCustomer?: (id: string) => void;
}) {
  const isEdit = !!editing;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState(editing?.name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [birthday, setBirthday] = useState(toDateInput(editingBirthday(editing)));
  const [notes, setNotes] = useState(editingNotes(editing) ?? "");
  const [consent, setConsent] = useState(editing?.marketingConsent ?? false);
  // Phase 6.4 — channel-level opt-ins (only meaningful with consent)
  const [optWhatsapp, setOptWhatsapp] = useState(editing?.whatsappOptIn ?? false);
  const [optSms, setOptSms] = useState(editing?.smsOptIn ?? false);
  const [optEmail, setOptEmail] = useState(editing?.emailOptIn ?? false);
  const [vip, setVip] = useState(editing?.vip ?? false);

  // Optional "more details" block — kept from the previous form so no existing
  // field is removed, but out of the way of the everyday add-customer flow.
  const [showMore, setShowMore] = useState(false);
  const [roomPreference, setRoomPreference] = useState(editingRoomPref(editing) ?? "");
  const [foodPreference, setFoodPreference] = useState(editingFoodPref(editing) ?? "");
  const [location, setLocation] = useState(editingLocation(editing) ?? "");
  const [anniversary, setAnniversary] = useState(toDateInput(editingAnniversary(editing)));
  const [source, setSource] = useState(editingSource(editing) ?? "");

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; message: string } | null>(
    null,
  );
  // Hard guard against repeated submissions (double click / Enter twice).
  const submittingRef = useRef(false);

  /** Client-side validation — mirrors the server schema exactly. */
  function validate(): FieldErrors {
    const parsed = parseWithFieldErrors(customerCreateSchema, {
      name,
      phone,
      email,
      birthday,
      notes,
      vip,
      marketingConsent: consent,
      whatsappOptIn: optWhatsapp,
      smsOptIn: optSms,
      emailOptIn: optEmail,
    });
    const errors: FieldErrors = { ...(parsed.errors ?? {}) };
    if (!errors.phone) {
      const result = normalizePhone(phone);
      if (!result.ok) errors.phone = result.error || "Please enter a valid phone number.";
    }
    return errors;
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        return api.patch<{ customer: CustomerRow }>(`/api/customers/${editing!.id}`, {
          name,
          phone,
          email,
          birthday: birthday || null,
          notes,
          vip,
          marketingConsent: consent,
          whatsappOptIn: optWhatsapp,
          smsOptIn: optSms,
          emailOptIn: optEmail,
          roomPreference,
          foodPreference,
          location,
          anniversary: anniversary || null,
          source: source || null,
        });
      }
      return api.post<{ customer: CustomerRow }>("/api/customers", {
        name,
        phone,
        email,
        birthday: birthday || undefined,
        notes: notes || undefined,
        vip,
        marketingConsent: consent,
        whatsappOptIn: optWhatsapp,
        smsOptIn: optSms,
        emailOptIn: optEmail,
        consentSource: "MANUAL_ENTRY",
        roomPreference: roomPreference || undefined,
        foodPreference: foodPreference || undefined,
        location: location || undefined,
        anniversary: anniversary || undefined,
        source: source || undefined,
      });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({
        title: isEdit ? "Customer updated" : "Customer added",
        description: isEdit
          ? `${name}'s details were saved.`
          : `${name} is now in your customer list.`,
      });
      onOpenChange(false);
      onSaved?.(res.customer);
    },
    onError: (err) => {
      setFieldErrors({});
      setDuplicate(null);
      if (err instanceof ApiError) {
        // Server-side field errors (authoritative validation) land under the
        // matching input, and the values the user typed stay in the form.
        const fields = err.details?.fields;
        if (fields && typeof fields === "object") {
          setFieldErrors(fields as FieldErrors);
          setFormError("Please fix the highlighted fields and try again.");
          return;
        }
        if (err.code === "DUPLICATE_PHONE") {
          const existing = err.details?.existing as { id?: string; name?: string } | undefined;
          setDuplicate({
            id: existing?.id ?? "",
            name: existing?.name ?? "this customer",
            message: err.message,
          });
          setFormError(null);
          return;
        }
        setFormError(err.message);
        return;
      }
      setFormError("Customer could not be saved. Please try again.");
    },
    onSettled: () => {
      submittingRef.current = false;
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current || mutation.isPending) return;
    setFormError(null);
    setDuplicate(null);
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setFormError("Please fix the highlighted fields and try again.");
      return;
    }
    submittingRef.current = true;
    mutation.mutate();
  }

  const busy = mutation.isPending;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {isEdit ? (
            <>
              <Pencil className="h-4 w-4 text-primary" /> Edit customer
            </>
          ) : (
            <>
              <UserPlus className="h-4 w-4 text-primary" /> Add customer
            </>
          )}
        </DialogTitle>
        <DialogDescription>
          {isEdit
            ? "Update this customer's details."
            : "Add a customer to your restaurant's list. Only the name and phone number are required."}
        </DialogDescription>
      </DialogHeader>

      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      {duplicate && (
        <Alert className="border-amber-500/40 bg-amber-500/10 text-[color:var(--gold-ink)] dark:text-[color:var(--gold)]">
          <AlertDescription className="space-y-3">
            <p>{duplicate.message}</p>
            {duplicate.id && onOpenCustomer && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  onOpenCustomer(duplicate.id);
                }}
              >
                <UserCheck className="h-4 w-4" /> Open {duplicate.name}&apos;s profile
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-3">
          <Field
            id="c-name"
            label="Customer name"
            required
            error={fieldErrors.name}
            hint="As they like to be addressed."
          >
            <Input
              id="c-name"
              placeholder="e.g. Rahul Sharma"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!fieldErrors.name}
              aria-describedby={fieldErrors.name ? "c-name-error" : undefined}
              autoComplete="off"
            />
          </Field>

          <Field
            id="c-phone"
            label="Mobile number"
            required
            error={fieldErrors.phone}
            hint="We clean up the format automatically. One number per customer."
          >
            <Input
              id="c-phone"
              inputMode="tel"
              placeholder="+91 98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-invalid={!!fieldErrors.phone}
              aria-describedby={fieldErrors.phone ? "c-phone-error" : undefined}
              autoComplete="off"
            />
          </Field>

          <Field id="c-email" label="Email" error={fieldErrors.email} hint="Optional.">
            <Input
              id="c-email"
              type="email"
              placeholder="guest@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!fieldErrors.email}
              aria-describedby={fieldErrors.email ? "c-email-error" : undefined}
              autoComplete="off"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field id="c-birthday" label="Birthday" error={fieldErrors.birthday} hint="Optional.">
              <Input
                id="c-birthday"
                type="date"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
                aria-invalid={!!fieldErrors.birthday}
              />
            </Field>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <Checkbox checked={vip} onCheckedChange={(v) => setVip(v === true)} />
                <span className="text-[13px]">
                  Mark as <span className="font-semibold">VIP</span> customer
                </span>
              </label>
            </div>
          </div>

          <Field id="c-notes" label="Notes" error={fieldErrors.notes} hint="Optional.">
            <Textarea
              id="c-notes"
              placeholder="Anything worth remembering — favourite table, allergic to nuts, celebrates here…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="resize-none"
              aria-invalid={!!fieldErrors.notes}
            />
          </Field>
        </div>

        {/* Marketing consent — an explicit opt-in, deliberately SEPARATE from
            registering the customer. Unticked simply means "not consented". */}
        <div className="rounded-lg border bg-accent/40 p-3.5">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={consent}
              onCheckedChange={(v) => {
                setConsent(v === true);
                if (v !== true) {
                  // Revoking marketing consent revokes every channel with it.
                  setOptWhatsapp(false);
                  setOptSms(false);
                  setOptEmail(false);
                }
              }}
              className="mt-0.5"
            />
            <span className="text-[13px] leading-snug">
              This customer <span className="font-semibold">agreed to receive</span> promotional
              offers and updates.{" "}
              <span className="text-muted-foreground">
                (Optional — registering a customer is not consent to market to them.)
              </span>
            </span>
          </label>
          {consent && (
            <div className="mt-2.5 ml-8 space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Which channels did they agree to?
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {[
                  { label: "WhatsApp", checked: optWhatsapp, set: setOptWhatsapp },
                  { label: "SMS", checked: optSms, set: setOptSms },
                  { label: "Email", checked: optEmail, set: setOptEmail },
                ].map((ch) => (
                  <label
                    key={ch.label}
                    className="flex cursor-pointer items-center gap-2 text-[13px]"
                  >
                    <Checkbox checked={ch.checked} onCheckedChange={(v) => ch.set(v === true)} />
                    {ch.label}
                  </label>
                ))}
              </div>
            </div>
          )}
          <p className="mt-2 flex items-start gap-1.5 pl-8 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3 mt-0.5 shrink-0" />
            Only tick this if the customer actually said yes. Each channel is checked separately
            before any campaign can contact them.
          </p>
        </div>

        {/* Optional extras from the original form (kept, but collapsed). */}
        <div className="rounded-lg border">
          <button
            type="button"
            onClick={() => setShowMore((s) => !s)}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left text-xs font-semibold text-muted-foreground hover:text-foreground"
            aria-expanded={showMore}
          >
            <span className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" /> Additional details (optional)
            </span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${showMore ? "rotate-180" : ""}`}
            />
          </button>
          {showMore && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t p-3.5">
              <div className="space-y-1.5">
                <Label htmlFor="c-room">Room preference</Label>
                <Input
                  id="c-room"
                  placeholder="e.g. Deluxe, Sea View"
                  value={roomPreference}
                  onChange={(e) => setRoomPreference(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-food">Food preference</Label>
                <Input
                  id="c-food"
                  placeholder="e.g. Veg, Jain"
                  value={foodPreference}
                  onChange={(e) => setFoodPreference(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-location">City / location</Label>
                <Input
                  id="c-location"
                  placeholder="e.g. Jaipur"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Source</Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger aria-label="Customer source">
                    <SelectValue placeholder="How did they find you?" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WALK_IN">Walk-in</SelectItem>
                    <SelectItem value="BOOKING">Booking</SelectItem>
                    <SelectItem value="WEBSITE">Website</SelectItem>
                    <SelectItem value="REFERRAL">Referral</SelectItem>
                    <SelectItem value="OTHER">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-anniversary">Anniversary</Label>
                <Input
                  id="c-anniversary"
                  type="date"
                  value={anniversary}
                  onChange={(e) => setAnniversary(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              "Save changes"
            ) : (
              "Add customer"
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function Field({
  id,
  label,
  required,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[11.5px] font-medium text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

// Accessors for fields that may exist on the editing row
function editingRoomPref(c: CustomerRow | null): string | null {
  return (c as unknown as { roomPreference?: string | null } | null)?.roomPreference ?? null;
}
function editingFoodPref(c: CustomerRow | null): string | null {
  return (c as unknown as { foodPreference?: string | null } | null)?.foodPreference ?? null;
}
function editingLocation(c: CustomerRow | null): string | null {
  return (c as unknown as { location?: string | null } | null)?.location ?? null;
}
function editingBirthday(c: CustomerRow | null): string | null {
  return (c as unknown as { birthday?: string | null } | null)?.birthday ?? null;
}
function editingAnniversary(c: CustomerRow | null): string | null {
  return (c as unknown as { anniversary?: string | null } | null)?.anniversary ?? null;
}
function editingSource(c: CustomerRow | null): string | null {
  return (c as unknown as { source?: string | null } | null)?.source ?? null;
}
function editingNotes(c: CustomerRow | null): string | null {
  return (c as unknown as { notes?: string | null } | null)?.notes ?? null;
}
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  // BUG FIX (2026-10-21, BUG_REPORT_NEW M-4): birthday/anniversary are
  // DATE-ONLY columns stored at UTC midnight. Reading them with local getters
  // showed "1990-05-14" to any browser west of UTC, and saving that value back
  // shifted the date by a day on every edit round-trip.
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
