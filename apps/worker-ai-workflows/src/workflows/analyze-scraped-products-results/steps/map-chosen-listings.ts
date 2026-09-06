import type { ChosenListing } from "../../../lib/prompt/analyze-results-response"
import type {
  ScrapedProductInsert,
  UnprocessedScrapeResult,
} from "../../../lib/db/scraped-products-swap.repository"
import { PLACEHOLDER_IMAGE_URL } from "../../../lib/db/scraped-products-swap.repository"

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

/**
 * Maps LLM choices onto scrape results. Unknown ids, duplicate result ids,
 * and terms with no usable listing are omitted. Each insert carries the
 * source `results_search_terms_scraped_products.id`.
 */
export function buildChosenProductInserts(
  chosen: ChosenListing[],
  results: UnprocessedScrapeResult[],
): ScrapedProductInsert[] {
  const byResultId = new Map(results.map((row) => [row.resultId, row]))
  const usedResultIds = new Set<string>()
  const products: ScrapedProductInsert[] = []

  for (const choice of chosen) {
    const row = byResultId.get(choice.resultId)
    if (!row) continue
    if (row.searchTermId !== choice.searchTermScrapedProductId) continue
    if (usedResultIds.has(row.resultId)) continue

    const json = row.jsonResult
    const title = asString(json.title).trim()
    const url = asString(json.url).trim()
    if (!title || !url) continue

    const searchTerm = asString(row.jsonSearch.term).trim()
    const imageUrl = asString(json.image_url).trim() || PLACEHOLDER_IMAGE_URL
    const currency = asString(json.currency).trim() || "BRL"

    usedResultIds.add(row.resultId)
    products.push({
      resultSearchTermScrapedProductId: row.resultId,
      marketplace: asString(json.marketplace) || row.marketplace,
      title,
      price: asNumber(json.price, 0),
      currency,
      url,
      imageUrl,
      searchTerm,
      scrapingMetadata: {
        marketplace: asString(json.marketplace) || row.marketplace,
        resultId: row.resultId,
        searchTermId: row.searchTermId,
        metadata: asObject(json.metadata),
      },
    })
  }

  return products
}
