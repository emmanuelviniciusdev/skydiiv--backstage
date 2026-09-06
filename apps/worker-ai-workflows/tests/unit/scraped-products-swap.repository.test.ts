import { describe, it, expect, vi } from "vitest"
import type postgres from "postgres"
import {
  SqlScrapedProductsSwapRepository,
  uniqueSearchTermIds,
} from "../../src/lib/db/scraped-products-swap.repository"

type SqlMock = ReturnType<typeof vi.fn> & {
  begin?: ReturnType<typeof vi.fn>
  json?: (value: unknown) => unknown
}

function makeWriteDb(): { db: postgres.Sql; tx: ReturnType<typeof vi.fn>; begin: ReturnType<typeof vi.fn> } {
  const tx = vi.fn().mockImplementation((first: unknown) => {
    if (Array.isArray(first) && !Object.prototype.hasOwnProperty.call(first, "raw")) {
      return first
    }
    return Promise.resolve([{ id: "domain-1" }])
  })
  Object.assign(tx, { json: (value: unknown) => value })

  const db = vi.fn().mockResolvedValue([{ id: "domain-1" }]) as unknown as SqlMock
  db.json = (value: unknown) => value
  const begin = vi.fn().mockImplementation(async (fn: (t: ReturnType<typeof vi.fn>) => Promise<unknown>) => {
    return await fn(tx)
  })
  db.begin = begin
  return { db: db as unknown as postgres.Sql, tx, begin }
}

function getSqlCallStrings(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls
    .map((call) => {
      const first = call[0]
      if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw")) {
        return first.filter((s): s is string => typeof s === "string").join(" ")
      }
      return ""
    })
    .filter((sql) => sql.length > 0)
}

function getSqlStrings(mock: ReturnType<typeof vi.fn>): string {
  return getSqlCallStrings(mock).join(" ")
}

function getInterpolatedValues(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.flatMap((call) => {
    const first = call[0]
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw")) {
      return call.slice(1)
    }
    return []
  })
}

const PRODUCT = {
  resultSearchTermScrapedProductId: "r-new",
  marketplace: "enjoei",
  title: "Blazer bege",
  price: 80,
  currency: "BRL",
  url: "https://www.enjoei.com.br/p/1",
  imageUrl: "https://img.example/1.jpg",
  searchTerm: "blazer casual",
  scrapingMetadata: { marketplace: "enjoei" },
}

describe("uniqueSearchTermIds", () => {
  it("deduplicates search-term ids from this run's results", () => {
    expect(
      uniqueSearchTermIds([
        {
          resultId: "r1",
          searchTermId: "s1",
          jsonResult: {},
          jsonSearch: {},
          marketplace: "enjoei",
        },
        {
          resultId: "r2",
          searchTermId: "s1",
          jsonResult: {},
          jsonSearch: {},
          marketplace: "enjoei",
        },
        {
          resultId: "r3",
          searchTermId: "s2",
          jsonResult: {},
          jsonSearch: {},
          marketplace: "enjoei",
        },
      ]),
    ).toEqual(["s1", "s2"])
  })
})

describe("SqlScrapedProductsSwapRepository.swapForPanorama", () => {
  it("is a no-op when the product list is empty (no register deletes)", async () => {
    const { db, begin } = makeWriteDb()
    const repo = new SqlScrapedProductsSwapRepository(db)
    await repo.swapForPanorama({
      wardrobePanoramaId: "p1",
      products: [],
      keepSearchTermIds: ["s1"],
    })
    expect(begin).not.toHaveBeenCalled()
  })

  it("replaces products then deletes only prior registers, keeping this run's ids", async () => {
    const { db, tx, begin } = makeWriteDb()
    const repo = new SqlScrapedProductsSwapRepository(db)

    await repo.swapForPanorama({
      wardrobePanoramaId: "p1",
      products: [PRODUCT],
      keepSearchTermIds: ["s-new"],
    })

    expect(begin).toHaveBeenCalledOnce()
    const calls = getSqlCallStrings(tx)
    expect(calls[0]).toMatch(/DELETE FROM scraped_products/)
    expect(calls[1]).toMatch(/INSERT INTO scraped_products/)
    expect(calls[1]).toMatch(/result_search_term_scraped_product_id/)
    expect(calls[2]).toMatch(/DELETE FROM results_search_terms_scraped_products/)
    expect(calls[2]).toMatch(/NOT IN/)
    expect(calls[3]).toMatch(/DELETE FROM search_terms_scraped_products/)
    expect(calls[3]).toMatch(/NOT IN/)
    expect(calls[4]).toMatch(/UPDATE results_search_terms_scraped_products/)
    expect(calls[4]).toMatch(/is_processed = true/)

    const sql = calls.join(" ")
    expect(sql).not.toMatch(/DELETE FROM scraped_products[\s\S]*INSERT INTO scraped_products[\s\S]*DELETE FROM scraped_products/)

    const values = getInterpolatedValues(tx)
    expect(values).toContain("p1")
    expect(values).toContain("r-new")
    expect(values).toContainEqual(["s-new"])
    expect(values).not.toContain("p2")
  })

  it("does not delete search or result registers when keepSearchTermIds is empty", async () => {
    const { db, tx, begin } = makeWriteDb()
    const repo = new SqlScrapedProductsSwapRepository(db)

    await repo.swapForPanorama({
      wardrobePanoramaId: "p1",
      products: [PRODUCT],
      keepSearchTermIds: [],
    })

    expect(begin).toHaveBeenCalledOnce()
    const sql = getSqlStrings(tx)
    expect(sql).toMatch(/DELETE FROM scraped_products/)
    expect(sql).toMatch(/INSERT INTO scraped_products/)
    expect(sql).not.toMatch(/DELETE FROM results_search_terms_scraped_products/)
    expect(sql).not.toMatch(/DELETE FROM search_terms_scraped_products/)
  })
})
