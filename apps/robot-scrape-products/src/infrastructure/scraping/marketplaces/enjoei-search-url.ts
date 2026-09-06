import type { SearchParams } from "../../../domain/entities/search-params.js"

export const ENJOEI_ORIGIN = "https://www.enjoei.com.br"

/**
 * Maps SkyDIIV shopping-suggestions gender values to Enjoei department slugs.
 * "No preference" (and unknown values) omit the department filter.
 *
 * `mocas` / `rapazes` are Enjoei's legacy aliases and still resolve, but the
 * current slugs are `feminino` / `masculino`.
 */
const GENDER_TO_DEPARTMENT: Record<string, string> = {
  female: "feminino",
  male: "masculino",
  feminino: "feminino",
  masculino: "masculino",
}

/**
 * Parses a stored size list ("M, G" or "40") into individual tokens.
 */
export function parseSizeList(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * Enjoei size option slugs are lowercase and unaccented ("m", "pp", "40",
 * "unico"). An unknown slug makes Enjoei return zero results rather than
 * ignoring the filter, so normalization has to match their option slugs.
 */
export function toEnjoeiSizeSlug(size: string): string {
  return size
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
}

/**
 * Enjoei brand filter slugs are lowercase kebab-case (e.g. "emporio-armani").
 */
export function toEnjoeiBrandSlug(brand: string): string {
  return brand
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Resolves a SkyDIIV gender preference to an Enjoei `d` slug, or null when
 * the department filter should be omitted.
 */
export function mapGenderToEnjoeiDepartment(gender: string | null): string | null {
  if (!gender) return null
  const key = gender.trim().toLowerCase()
  if (!key || key === "no preference" || key === "no-preference") {
    return null
  }
  return GENDER_TO_DEPARTMENT[key] ?? null
}

/**
 * Every size token requested for a search, as Enjoei slugs, regardless of the
 * size type it belongs to. An empty list means "any size is acceptable".
 */
export function requestedEnjoeiSizeSlugs(params: SearchParams): string[] {
  const tokens = [
    ...parseSizeList(params.topSize),
    ...parseSizeList(params.bottomSize),
    ...parseSizeList(params.footSize),
  ].map(toEnjoeiSizeSlug)

  return [...new Set(tokens.filter((slug) => slug.length > 0))]
}

/**
 * Whether a listing's size satisfies the requested sizes.
 *
 * A null/blank listing size is *not* a match: the size has to be read from the
 * listing before it can be trusted (see `EnjoeiScraper`).
 */
export function matchesRequestedEnjoeiSize(
  requestedSlugs: string[],
  listingSize: string | null | undefined,
): boolean {
  if (requestedSlugs.length === 0) return true
  if (!listingSize) return false
  return requestedSlugs.includes(toEnjoeiSizeSlug(listingSize))
}

/**
 * Builds an Enjoei search URL with advanced filters.
 *
 * Query params (from Enjoei `abbr-params-map`):
 * - `q`  — search term (`query`)
 * - `d`  — department / gender (`feminino` | `masculino`)
 * - `b`  — brand slug (`brands`)
 * - `sc` — clothes / top sizes (repeat)
 * - `sw` — waist / bottom sizes (repeat)
 * - `ss` — shoes / foot sizes (repeat)
 *
 * `dep` is Enjoei's `recommendation_department`, **not** the department filter.
 */
export function buildEnjoeiSearchUrl(params: SearchParams): string {
  const url = new URL(`${ENJOEI_ORIGIN}/s/`)
  url.searchParams.set("q", params.searchTerm)

  const department = mapGenderToEnjoeiDepartment(params.gender)
  if (department) {
    url.searchParams.set("d", department)
  }

  if (params.brand?.trim()) {
    const brandSlug = toEnjoeiBrandSlug(params.brand)
    if (brandSlug) {
      url.searchParams.set("b", brandSlug)
    }
  }

  for (const size of parseSizeList(params.topSize)) {
    url.searchParams.append("sc", toEnjoeiSizeSlug(size))
  }
  for (const size of parseSizeList(params.bottomSize)) {
    url.searchParams.append("sw", toEnjoeiSizeSlug(size))
  }
  for (const size of parseSizeList(params.footSize)) {
    url.searchParams.append("ss", toEnjoeiSizeSlug(size))
  }

  return url.toString()
}
