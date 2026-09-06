import { randomUUID } from "crypto"
import type postgres from "postgres"

const CREATED_BY = "worker-ai-workflows"
const PLACEHOLDER_IMAGE_URL = "https://assets.skydiiv.space/placeholder--scraped-product.png"

export interface ScrapedProductInsert {
  resultSearchTermScrapedProductId: string
  marketplace: string
  title: string
  price: number
  currency: string
  url: string
  imageUrl: string
  searchTerm: string
  scrapingMetadata: Record<string, unknown>
}

export interface UnprocessedScrapeResult {
  resultId: string
  searchTermId: string
  jsonResult: Record<string, unknown>
  jsonSearch: Record<string, unknown>
  marketplace: string
}

export interface ScrapedProductsSwapRepository {
  findClothingItemProductTypeId(): Promise<string>
  findUnprocessedResultsForPanorama(
    wardrobePanoramaId: string,
  ): Promise<UnprocessedScrapeResult[]>
  swapForPanorama(input: {
    wardrobePanoramaId: string
    products: ScrapedProductInsert[]
    keepSearchTermIds: string[]
  }): Promise<void>
}

/** Search-term ids from this run's unprocessed results — keep these on swap. */
export function uniqueSearchTermIds(results: UnprocessedScrapeResult[]): string[] {
  return [...new Set(results.map((row) => row.searchTermId))]
}

interface DomainRow {
  id: string
}

interface ResultRow {
  result_id: string
  search_term_id: string
  json_result: unknown
  json_search: unknown
  marketplace: string
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export class SqlScrapedProductsSwapRepository implements ScrapedProductsSwapRepository {
  constructor(private readonly db: postgres.Sql) {}

  async findClothingItemProductTypeId(): Promise<string> {
    const rows = await this.db<DomainRow[]>`
      SELECT id
      FROM domains
      WHERE type = 'product_type'
        AND source = 'scraped_products'
        AND name = 'Clothing Item'
      LIMIT 1
    `
    const id = rows[0]?.id
    if (!id) {
      throw new Error(
        'Domain product_type "Clothing Item" (source=scraped_products) was not found',
      )
    }
    return id
  }

  async findUnprocessedResultsForPanorama(
    wardrobePanoramaId: string,
  ): Promise<UnprocessedScrapeResult[]> {
    const rows = await this.db<ResultRow[]>`
      SELECT
        r.id AS result_id,
        s.id AS search_term_id,
        r.json_result,
        s.json_search,
        s.marketplace
      FROM results_search_terms_scraped_products r
      INNER JOIN search_terms_scraped_products s
        ON s.id = r.search_term_scraped_product_id
      WHERE s.wardrobe_panorama_id = ${wardrobePanoramaId}
        AND r.is_processed = false
    `

    return rows.map((row) => ({
      resultId: row.result_id,
      searchTermId: row.search_term_id,
      jsonResult: asObject(row.json_result),
      jsonSearch: asObject(row.json_search),
      marketplace: row.marketplace,
    }))
  }

  /**
   * Atomically replaces scraped_products for a panorama. No-op when `products`
   * is empty — search/result registers are never deleted outside this swap.
   *
   * When inserting, last week's `scraped_products` are removed and the new
   * rows are kept, each linked to its source result via
   * `result_search_term_scraped_product_id`. Prior search-term/result rows
   * for other pipeline runs are removed; this run's ids in `keepSearchTermIds`
   * stay, with their result rows marked processed.
   */
  async swapForPanorama(input: {
    wardrobePanoramaId: string
    products: ScrapedProductInsert[]
    keepSearchTermIds: string[]
  }): Promise<void> {
    if (input.products.length === 0) return

    const productTypeId = await this.findClothingItemProductTypeId()
    const now = new Date()
    const keepSearchTermIds = [...new Set(input.keepSearchTermIds)]

    await this.db.begin(async (tx) => {
      await tx`
        DELETE FROM scraped_products
        WHERE wardrobe_panorama_id = ${input.wardrobePanoramaId}
      `

      for (const product of input.products) {
        await tx`
          INSERT INTO scraped_products (
            id,
            wardrobe_panorama_id,
            product_type_id,
            result_search_term_scraped_product_id,
            marketplace,
            title,
            price,
            currency,
            url,
            image_url,
            search_term,
            scraping_status,
            scraping_metadata,
            created_by,
            updated_by,
            created_at,
            updated_at
          ) VALUES (
            ${randomUUID()},
            ${input.wardrobePanoramaId},
            ${productTypeId},
            ${product.resultSearchTermScrapedProductId},
            ${product.marketplace},
            ${product.title},
            ${product.price},
            ${product.currency},
            ${product.url},
            ${product.imageUrl || PLACEHOLDER_IMAGE_URL},
            ${product.searchTerm},
            ${"SUCCESS"}::"ScrapedProductScrapingStatus",
            ${tx.json(product.scrapingMetadata)},
            ${CREATED_BY},
            ${CREATED_BY},
            ${now},
            ${now}
          )
        `
      }

      if (keepSearchTermIds.length > 0) {
        await tx`
          DELETE FROM results_search_terms_scraped_products
          WHERE search_term_scraped_product_id IN (
            SELECT id FROM search_terms_scraped_products
            WHERE wardrobe_panorama_id = ${input.wardrobePanoramaId}
              AND id NOT IN ${tx(keepSearchTermIds)}
          )
        `

        await tx`
          DELETE FROM search_terms_scraped_products
          WHERE wardrobe_panorama_id = ${input.wardrobePanoramaId}
            AND id NOT IN ${tx(keepSearchTermIds)}
        `

        await tx`
          UPDATE results_search_terms_scraped_products
          SET
            is_processed = true,
            updated_at = ${now},
            updated_by = ${CREATED_BY}
          WHERE search_term_scraped_product_id IN ${tx(keepSearchTermIds)}
            AND is_processed = false
        `
      }
    })
  }
}

export { PLACEHOLDER_IMAGE_URL }
