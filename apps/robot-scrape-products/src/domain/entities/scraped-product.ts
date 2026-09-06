/**
 * A clothing item scraped from a marketplace search result page.
 */
import type { SearchParams } from "./search-params.js"

export interface ScrapedProduct {
  marketplace: string
  title: string
  price: number | null
  currency: string | null
  url: string
  imageUrl: string | null
  /** Size as published by the marketplace, read from the listing's own record. */
  size: string | null
  /** Denormalized free-text query (also persisted in the search_term column). */
  searchTerm: string
  /** Full criteria used for this scrape (persisted in scraping_metadata). */
  searchParams: SearchParams
}

/**
 * Aggregate result of scraping one or more search terms on a marketplace.
 */
export interface ScrapeResult {
  marketplace: string
  userId: string
  products: ScrapedProduct[]
  scrapedAt: Date
}
