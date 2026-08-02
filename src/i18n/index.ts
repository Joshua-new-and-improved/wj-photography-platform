/**
 * The product ships in English only.
 *
 * §2.12 argued for bilingual Afrikaans/English copy, reasoning from the
 * Afrikaans reference slip and the Afrikaans-medium schools in the client list.
 * That was an argument about the market rather than a requirement, and the
 * studio has decided: English.
 *
 * The mechanism stays. Every user-facing string still resolves through here and
 * the catalogue columns are still locale-keyed jsonb (migration 0012), so a
 * second language later is a data change and a copy deck rather than a hunt
 * through two hundred components. Dormant, this costs nothing; removed, it
 * costs something real to put back.
 *
 * Locale resolution order is unchanged: guardian preference → school default →
 * studio default. With one locale configured they all resolve to English.
 */
export const LOCALES = ["en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export function resolveLocale(opts: {
  guardian?: string | null;
  school?: string | null;
  studio?: string | null;
}): Locale {
  for (const candidate of [opts.guardian, opts.school, opts.studio]) {
    if (candidate && (LOCALES as readonly string[]).includes(candidate)) {
      return candidate as Locale;
    }
  }
  return DEFAULT_LOCALE;
}

/** Read a jsonb i18n column (product.name_i18n and friends) with fallback. */
export function pick(
  field: Partial<Record<Locale, string>> | null | undefined,
  locale: Locale,
): string {
  if (!field) return "";
  return field[locale] ?? field[DEFAULT_LOCALE] ?? Object.values(field)[0] ?? "";
}

/** ZAR, VAT-inclusive, formatted the way South African consumers expect. */
export function formatZar(cents: number, locale: Locale = DEFAULT_LOCALE): string {
  // en-ZA gives "R1 234,56" — space thousands separator, comma decimal, which
  // is what South African consumers read regardless of home language.
  return new Intl.NumberFormat(locale === "en" ? "en-ZA" : "en-ZA", {
    style: "currency",
    currency: "ZAR",
  }).format(cents / 100);
}
