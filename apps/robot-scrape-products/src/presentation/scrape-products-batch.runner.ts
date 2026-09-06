import type { Logger } from "../domain/ports/logger.port.js"
import type { MarketplaceScraperPort } from "../domain/ports/marketplace-scraper.port.js"
import type { SelfDeletePort } from "../domain/ports/self-delete.port.js"
import type { SqlOutboxEventsRepository } from "../infrastructure/db/outbox-events.repository.js"
import type { SqlSearchResultsRepository } from "../infrastructure/db/search-results.repository.js"
import type {
  SearchTermGroup,
  SqlSearchTermsRepository,
  UnprocessedSearchTerm,
} from "../infrastructure/db/search-terms.repository.js"
import {
  PLACEHOLDER_IMAGE_URL,
  type JsonResult,
} from "../infrastructure/db/json-search.js"
import type { OutboxPublisherPort } from "../infrastructure/messaging/qstash-outbox.publisher.js"
import { jsonSearchToSearchParams } from "../infrastructure/scraping/json-search-to-params.js"
import type { ScrapedProduct } from "../domain/entities/scraped-product.js"
import { toSearchParamsJson } from "../domain/entities/search-params.js"

export interface ScrapeProductsBatchRunnerDeps {
  searchTermsRepository: SqlSearchTermsRepository
  searchResultsRepository: SqlSearchResultsRepository
  outboxRepository: SqlOutboxEventsRepository
  outboxPublisher: OutboxPublisherPort
  resolveScraper: (marketplace: string) => MarketplaceScraperPort | null
  selfDelete: SelfDeletePort
  logger: Logger
  concurrency: number
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>()
  for (const item of items) {
    const task = worker(item).finally(() => {
      executing.delete(task)
    })
    executing.add(task)
    if (executing.size >= concurrency) {
      await Promise.race(executing)
    }
  }
  await Promise.all(executing)
}

function toJsonResult(product: ScrapedProduct): JsonResult {
  return {
    marketplace: product.marketplace,
    title: product.title,
    price: product.price ?? 0,
    currency: product.currency ?? "BRL",
    url: product.url,
    image_url: product.imageUrl || PLACEHOLDER_IMAGE_URL,
    metadata: {
      size: product.size,
      searchParams: toSearchParamsJson(product.searchParams),
    },
  }
}

export class ScrapeProductsBatchRunner {
  constructor(private readonly deps: ScrapeProductsBatchRunnerDeps) {}

  async start(): Promise<void> {
    this.deps.logger.info("Scrape products batch runner started", {
      concurrency: this.deps.concurrency,
    })

    try {
      const groups = await this.deps.searchTermsRepository.findUnprocessedGroupedByPanorama()
      this.deps.logger.info("Unprocessed search-term groups loaded", {
        panoramaCount: groups.length,
        termCount: groups.reduce((sum, g) => sum + g.terms.length, 0),
      })

      for (const group of groups) {
        await this.processPanorama(group)
      }
    } finally {
      this.deps.logger.info("Invoking self-delete after scrape batch")
      try {
        await this.deps.selfDelete.deleteSelf()
      } catch (err) {
        this.deps.logger.error("Self-delete failed — GHA terraform destroy remains the fallback", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async processPanorama(group: SearchTermGroup): Promise<void> {
    await runPool(group.terms, this.deps.concurrency, (term) => this.processTerm(term))

    const outboxEventId = await this.deps.outboxRepository.insertAnalyzeScrapedProductsResults({
      wardrobePanoramaId: group.wardrobePanoramaId,
    })
    this.deps.logger.info("Analyze outbox inserted", {
      wardrobePanoramaId: group.wardrobePanoramaId,
      outboxEventId,
    })

    try {
      await this.deps.outboxPublisher.publishProcessOutboxEvent([outboxEventId])
      this.deps.logger.info("Analyze outbox published", { outboxEventId })
    } catch (err) {
      this.deps.logger.warn("Failed to publish analyze outbox — catch-up will retry", {
        outboxEventId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async processTerm(term: UnprocessedSearchTerm): Promise<void> {
    const scraper = this.deps.resolveScraper(term.marketplace)
    if (!scraper) {
      this.deps.logger.warn("Unknown marketplace — marking term processed without results", {
        searchTermId: term.id,
        marketplace: term.marketplace,
      })
      await this.deps.searchResultsRepository.insertResultsAndMarkProcessed({
        searchTermId: term.id,
        results: [],
      })
      return
    }

    const searchParams = jsonSearchToSearchParams(term.jsonSearch)
    let results: JsonResult[] = []
    try {
      const products = await scraper.scrape({
        searchParams: [searchParams],
        userId: term.wardrobePanoramaId,
      })
      results = products.map(toJsonResult)
    } catch (err) {
      this.deps.logger.warn("Scrape failed — marking term processed with empty results", {
        searchTermId: term.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    await this.deps.searchResultsRepository.insertResultsAndMarkProcessed({
      searchTermId: term.id,
      results,
    })
  }
}
