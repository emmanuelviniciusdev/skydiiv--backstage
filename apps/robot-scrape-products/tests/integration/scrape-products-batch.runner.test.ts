import { describe, expect, it, vi } from "vitest"
import { ScrapeProductsBatchRunner } from "../../src/presentation/scrape-products-batch.runner.js"
import type { MarketplaceScraperPort } from "../../src/domain/ports/marketplace-scraper.port.js"
import type { Logger } from "../../src/domain/ports/logger.port.js"

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe("ScrapeProductsBatchRunner", () => {
  it("inserts one analyze outbox row per panorama and does not write scraped_products", async () => {
    const findUnprocessedGroupedByPanorama = vi.fn().mockResolvedValue([
      {
        wardrobePanoramaId: "p1",
        terms: [
          {
            id: "t1",
            wardrobePanoramaId: "p1",
            marketplace: "enjoei",
            jsonSearch: { term: "blazer", gender: null, topSize: null, bottomSize: null, footSize: null },
          },
        ],
      },
      {
        wardrobePanoramaId: "p2",
        terms: [
          {
            id: "t2",
            wardrobePanoramaId: "p2",
            marketplace: "enjoei",
            jsonSearch: { term: "saia", gender: null, topSize: null, bottomSize: null, footSize: null },
          },
        ],
      },
    ])
    const insertResultsAndMarkProcessed = vi.fn().mockResolvedValue(undefined)
    const insertAnalyze = vi.fn().mockResolvedValueOnce("outbox-1").mockResolvedValueOnce("outbox-2")
    const publish = vi.fn().mockResolvedValue(undefined)
    const deleteSelf = vi.fn().mockResolvedValue(undefined)
    const scrape = vi.fn().mockResolvedValue([
      {
        marketplace: "enjoei",
        title: "Blazer",
        price: 10,
        currency: "BRL",
        url: "https://www.enjoei.com.br/p/1",
        imageUrl: "https://img.example/1.jpg",
        size: "M",
        searchTerm: "blazer",
        searchParams: {
          searchTerm: "blazer",
          gender: null,
          topSize: "M",
          bottomSize: null,
          footSize: null,
          brand: null,
        },
      },
    ])

    const scraper: MarketplaceScraperPort = { marketplace: "enjoei", scrape }

    const runner = new ScrapeProductsBatchRunner({
      searchTermsRepository: { findUnprocessedGroupedByPanorama } as never,
      searchResultsRepository: { insertResultsAndMarkProcessed } as never,
      outboxRepository: { insertAnalyzeScrapedProductsResults: insertAnalyze } as never,
      outboxPublisher: { publishProcessOutboxEvent: publish },
      resolveScraper: () => scraper,
      selfDelete: { deleteSelf },
      logger: silentLogger(),
      concurrency: 2,
    })

    await runner.start()

    expect(insertAnalyze).toHaveBeenCalledTimes(2)
    expect(insertAnalyze).toHaveBeenNthCalledWith(1, { wardrobePanoramaId: "p1" })
    expect(insertAnalyze).toHaveBeenNthCalledWith(2, { wardrobePanoramaId: "p2" })
    expect(publish).toHaveBeenCalledTimes(2)
    expect(deleteSelf).toHaveBeenCalledOnce()
  })

  it("persists the confirmed listing size in json_result.metadata", async () => {
    const insertResultsAndMarkProcessed = vi.fn().mockResolvedValue(undefined)

    const runner = new ScrapeProductsBatchRunner({
      searchTermsRepository: {
        findUnprocessedGroupedByPanorama: vi.fn().mockResolvedValue([
          {
            wardrobePanoramaId: "p1",
            terms: [
              {
                id: "t1",
                wardrobePanoramaId: "p1",
                marketplace: "enjoei",
                jsonSearch: {
                  term: "blusa",
                  gender: "Female",
                  topSize: "M",
                  bottomSize: null,
                  footSize: null,
                },
              },
            ],
          },
        ]),
      } as never,
      searchResultsRepository: { insertResultsAndMarkProcessed } as never,
      outboxRepository: {
        insertAnalyzeScrapedProductsResults: vi.fn().mockResolvedValue("outbox-1"),
      } as never,
      outboxPublisher: { publishProcessOutboxEvent: vi.fn() },
      resolveScraper: () => ({
        marketplace: "enjoei",
        scrape: vi.fn().mockResolvedValue([
          {
            marketplace: "enjoei",
            title: "blusa de linho",
            price: 80,
            currency: "BRL",
            url: "https://www.enjoei.com.br/p/blusa-1",
            imageUrl: "https://img.example/1.jpg",
            size: "M",
            searchTerm: "blusa",
            searchParams: {
              searchTerm: "blusa",
              gender: "Female",
              topSize: "M",
              bottomSize: null,
              footSize: null,
              brand: null,
            },
          },
        ]),
      }),
      selfDelete: { deleteSelf: vi.fn() },
      logger: silentLogger(),
      concurrency: 2,
    })

    await runner.start()

    expect(insertResultsAndMarkProcessed).toHaveBeenCalledWith({
      searchTermId: "t1",
      results: [
        expect.objectContaining({
          title: "blusa de linho",
          metadata: expect.objectContaining({ size: "M" }),
        }),
      ],
    })
  })

  it("skips already-processed terms because the repository only returns unprocessed rows", async () => {
    const scrape = vi.fn()
    const runner = new ScrapeProductsBatchRunner({
      searchTermsRepository: {
        findUnprocessedGroupedByPanorama: vi.fn().mockResolvedValue([]),
      } as never,
      searchResultsRepository: { insertResultsAndMarkProcessed: vi.fn() } as never,
      outboxRepository: { insertAnalyzeScrapedProductsResults: vi.fn() } as never,
      outboxPublisher: { publishProcessOutboxEvent: vi.fn() },
      resolveScraper: () => ({ marketplace: "enjoei", scrape }),
      selfDelete: { deleteSelf: vi.fn() },
      logger: silentLogger(),
      concurrency: 2,
    })

    await runner.start()
    expect(scrape).not.toHaveBeenCalled()
  })

  it("marks unknown marketplace processed with no result rows and still enqueues analyze", async () => {
    const insertResultsAndMarkProcessed = vi.fn().mockResolvedValue(undefined)
    const insertAnalyze = vi.fn().mockResolvedValue("outbox-1")
    const scrape = vi.fn().mockResolvedValue([])

    const runner = new ScrapeProductsBatchRunner({
      searchTermsRepository: {
        findUnprocessedGroupedByPanorama: vi.fn().mockResolvedValue([
          {
            wardrobePanoramaId: "p1",
            terms: [
              {
                id: "t-unknown",
                wardrobePanoramaId: "p1",
                marketplace: "unknown-shop",
                jsonSearch: { term: "x", gender: null, topSize: null, bottomSize: null, footSize: null },
              },
              {
                id: "t-enjoei",
                wardrobePanoramaId: "p1",
                marketplace: "enjoei",
                jsonSearch: { term: "blazer", gender: null, topSize: null, bottomSize: null, footSize: null },
              },
            ],
          },
        ]),
      } as never,
      searchResultsRepository: { insertResultsAndMarkProcessed } as never,
      outboxRepository: { insertAnalyzeScrapedProductsResults: insertAnalyze } as never,
      outboxPublisher: { publishProcessOutboxEvent: vi.fn() },
      resolveScraper: (name) =>
        name.toLowerCase() === "enjoei" ? { marketplace: "enjoei", scrape } : null,
      selfDelete: { deleteSelf: vi.fn() },
      logger: silentLogger(),
      concurrency: 2,
    })

    await runner.start()

    expect(insertResultsAndMarkProcessed).toHaveBeenCalledWith({
      searchTermId: "t-unknown",
      results: [],
    })
    expect(scrape).toHaveBeenCalledOnce()
    expect(insertAnalyze).toHaveBeenCalledWith({ wardrobePanoramaId: "p1" })
  })
})
