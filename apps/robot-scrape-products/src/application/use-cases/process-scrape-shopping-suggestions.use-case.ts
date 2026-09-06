import type { ScrapedProduct, ScrapeResult } from "../../domain/entities/scraped-product.js"
import {
  toSearchParamsJson,
  type SearchParams,
} from "../../domain/entities/search-params.js"
import {
  toSearchParams,
  type ScrapeShoppingSuggestionsPayload,
} from "../../domain/events/scrape-shopping-suggestions.event.js"
import type { CachePort } from "../../domain/ports/cache.port.js"
import type { Logger } from "../../domain/ports/logger.port.js"
import type { MarketplaceScraperPort } from "../../domain/ports/marketplace-scraper.port.js"
import type {
  ScrapedProductInsert,
  ScrapedProductsRepositoryPort,
  ScrapingMetadata,
} from "../../domain/ports/scraped-products.repository.port.js"
import type { WardrobePanoramaRepositoryPort } from "../../domain/ports/wardrobe-panorama.repository.port.js"

export type MarketplaceScraperResolver = (marketplace: string) => MarketplaceScraperPort

export interface ProcessScrapeShoppingSuggestionsDeps {
  resolveScraper: MarketplaceScraperResolver
  wardrobePanoramaRepository: WardrobePanoramaRepositoryPort
  scrapedProductsRepository: ScrapedProductsRepositoryPort
  cache: CachePort
  logger: Logger
}

const DEFAULT_CURRENCY = "BRL"
const DEFAULT_IMAGE_URL =
  "https://assets.skydiiv.space/placeholder--scraped-product.png"
const DEFAULT_ERROR_URL = "#"

/**
 * Application use case: scrape clothing suggestions, replace scraped_products,
 * invalidate list cache, and set the "new shopping suggestions" notification flag.
 *
 * Flow:
 * 1. Load the user's wardrobe panorama
 * 2. Scrape the marketplace
 * 3. Delete existing scraped_products for the panorama
 * 4. Insert the new rows (SUCCESS or ERROR)
 * 5. Invalidate `shopping-suggestions:{userId}` on the **web** Redis
 * 6. On SUCCESS, SET `notification:new-shopping-suggestions:{userId}` on the **web** Redis
 */
export class ProcessScrapeShoppingSuggestionsUseCase {
  constructor(private readonly deps: ProcessScrapeShoppingSuggestionsDeps) {}

  async execute(payload: ScrapeShoppingSuggestionsPayload): Promise<ScrapeResult> {
    const marketplace = payload.marketplace.toLowerCase().trim()
    const userId = payload.userId
    const scrapedAt = new Date()
    const searchParams = payload.searchParams.map(toSearchParams)

    const panoramaId = await this.deps.wardrobePanoramaRepository.findIdByUserId(userId)
    if (!panoramaId) {
      throw new Error(`Wardrobe panorama not found for user "${userId}"`)
    }

    const productTypeId =
      await this.deps.scrapedProductsRepository.findClothingItemProductTypeId()

    this.deps.logger.info("Starting marketplace scrape", {
      marketplace,
      userId,
      panoramaId,
      searchParamCount: searchParams.length,
    })

    let products: ScrapedProduct[]
    try {
      const scraper = this.deps.resolveScraper(marketplace)
      products = await scraper.scrape({
        searchParams,
        userId,
      })
    } catch (err) {
      const errorMeta = toErrorMeta(err)

      this.deps.logger.error("Marketplace scrape failed — persisting ERROR status", {
        marketplace,
        userId,
        panoramaId,
        error: errorMeta.message,
      })

      const errorRows = searchParams.map((params) =>
        toErrorInsert({
          marketplace,
          searchParams: params,
          scrapedAt,
          error: errorMeta,
        }),
      )

      await this.deps.scrapedProductsRepository.replaceForPanorama({
        wardrobePanoramaId: panoramaId,
        productTypeId,
        products: errorRows,
      })
      await this.deps.cache.invalidateShoppingSuggestions(userId)

      // Do not re-throw: ERROR metadata is already persisted and the queue
      // runner always ACKs so the message is removed (no retries).
      return {
        marketplace,
        userId,
        products: [],
        scrapedAt,
      }
    }

    const result: ScrapeResult = {
      marketplace,
      userId,
      products,
      scrapedAt,
    }

    this.deps.logger.info("Marketplace scrape completed", {
      marketplace,
      userId,
      productCount: products.length,
    })

    this.deps.logger.debug("Scrape output", {
      marketplace,
      userId,
      scrapedAt: scrapedAt.toISOString(),
      searchParams,
      productCount: products.length,
      products,
    })

    const rows = products.map((product) => toSuccessInsert(product, marketplace, scrapedAt))

    await this.deps.scrapedProductsRepository.replaceForPanorama({
      wardrobePanoramaId: panoramaId,
      productTypeId,
      products: rows,
    })

    await this.deps.cache.invalidateShoppingSuggestions(userId)
    await this.deps.cache.setNewShoppingSuggestionsNotification(userId)

    return result
  }
}

function toSuccessInsert(
  product: ScrapedProduct,
  marketplace: string,
  scrapedAt: Date,
): ScrapedProductInsert {
  const metadata: ScrapingMetadata = {
    scrapedAt: scrapedAt.toISOString(),
    marketplace,
    searchParams: toSearchParamsJson(product.searchParams),
    size: product.size,
    raw: {
      title: product.title,
      price: product.price,
      currency: product.currency,
      url: product.url,
      imageUrl: product.imageUrl,
      size: product.size,
    },
  }

  return {
    marketplace,
    title: product.title.trim() || product.searchTerm,
    price: product.price ?? 0,
    currency: product.currency?.trim() || DEFAULT_CURRENCY,
    url: product.url.trim() || DEFAULT_ERROR_URL,
    imageUrl: product.imageUrl?.trim() || DEFAULT_IMAGE_URL,
    searchTerm: product.searchTerm,
    scrapingStatus: "SUCCESS",
    scrapingMetadata: metadata,
  }
}

function toErrorInsert(input: {
  marketplace: string
  searchParams: SearchParams
  scrapedAt: Date
  error: { message: string; name?: string; at: string }
}): ScrapedProductInsert {
  const searchTerm = input.searchParams.searchTerm
  return {
    marketplace: input.marketplace,
    title: `Scraping failed: ${searchTerm}`,
    price: 0,
    currency: DEFAULT_CURRENCY,
    url: DEFAULT_ERROR_URL,
    imageUrl: DEFAULT_IMAGE_URL,
    searchTerm,
    scrapingStatus: "ERROR",
    scrapingMetadata: {
      scrapedAt: input.scrapedAt.toISOString(),
      marketplace: input.marketplace,
      searchParams: toSearchParamsJson(input.searchParams),
      error: input.error,
    },
  }
}

function toErrorMeta(err: unknown): { message: string; name?: string; at: string } {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      at: new Date().toISOString(),
    }
  }
  return {
    message: String(err),
    at: new Date().toISOString(),
  }
}
