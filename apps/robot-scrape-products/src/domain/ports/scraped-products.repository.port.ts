import type { SearchParamsJson } from "../entities/search-params.js"

export type ScrapingStatus = "SUCCESS" | "ERROR"

/**
 * Useful scrape diagnostics persisted in `scraping_metadata` (JSONB).
 * Always include the raw extracted values — even when coerced for NOT NULL columns.
 */
export type ScrapingMetadata = {
  scrapedAt: string
  marketplace: string
  /** Full search criteria used for this scrape attempt. */
  searchParams: SearchParamsJson
  /** Size published by the marketplace, confirmed on the listing page. */
  size?: string | null
  /** Pure values as returned by the scraper (before DB coercion). */
  raw?: {
    title: string | null
    price: number | null
    currency: string | null
    url: string | null
    imageUrl: string | null
    size: string | null
  }
  error?: {
    message: string
    name?: string
    at: string
  }
}

export interface ScrapedProductInsert {
  marketplace: string
  title: string
  price: number
  currency: string
  url: string
  imageUrl: string
  searchTerm: string
  scrapingStatus: ScrapingStatus
  scrapingMetadata: ScrapingMetadata
}

export interface ReplaceScrapedProductsInput {
  wardrobePanoramaId: string
  productTypeId: string
  products: ScrapedProductInsert[]
}

/**
 * Port for replacing scraped shopping-suggestion products for a panorama.
 */
export interface ScrapedProductsRepositoryPort {
  /** Resolves the `domains` row for scraped clothing items. */
  findClothingItemProductTypeId(): Promise<string>

  /**
   * Atomically deletes existing scraped products for the panorama and inserts
   * the provided rows.
   */
  replaceForPanorama(input: ReplaceScrapedProductsInput): Promise<void>
}
