import { describe, it, expect, vi } from "vitest"
import { parseWardrobePanoramaIdPayload } from "../../src/lib/automatic-thrifting/payload"
import { parseAnalyzeResultsLlmOutput } from "../../src/lib/prompt/analyze-results-response"
import { buildChosenProductInserts } from "../../src/workflows/analyze-scraped-products-results/steps/map-chosen-listings"
import { loadAnalyzeContextStep } from "../../src/workflows/analyze-scraped-products-results/steps/load-context"
import { SqlScrapedProductsSwapRepository } from "../../src/lib/db/scraped-products-swap.repository"

const mocks = vi.hoisted(() => {
  const writeDb = vi.fn()
  const begin = vi.fn()
  Object.assign(writeDb, {
    json: (value: unknown) => value,
    begin,
  })
  return { writeDb, begin }
})

vi.mock("../../src/lib/db/client", () => ({
  getReadDb: () => mocks.writeDb,
  getWriteDb: () => mocks.writeDb,
  resetDbClients: vi.fn(),
}))

function sqlText(query: unknown): string {
  return Array.isArray(query) ? query.join("") : String(query)
}

const RESULT = {
  resultId: "r1",
  searchTermId: "s1",
  marketplace: "enjoei",
  jsonSearch: { term: "blazer casual" },
  jsonResult: {
    marketplace: "enjoei",
    title: "Blazer bege",
    price: 80,
    currency: "BRL",
    url: "https://www.enjoei.com.br/p/1",
    image_url: "https://img.example/1.jpg",
    metadata: { foo: "bar" },
  },
}

describe("analyze-scraped-products-results", () => {
  it("fails a missing panorama id without deletes", () => {
    expect(() => parseWardrobePanoramaIdPayload({ wardrobePanoramaId: "" })).toThrow(
      /wardrobePanoramaId/,
    )
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("maps zero LLM selections to an empty insert list so last week is kept", () => {
    const products = buildChosenProductInserts([], [RESULT])
    expect(products).toEqual([])
  })

  it("maps one chosen listing per search term", () => {
    const chosen = parseAnalyzeResultsLlmOutput(
      JSON.stringify([{ searchTermScrapedProductId: "s1", resultId: "r1" }]),
    )
    const products = buildChosenProductInserts(chosen, [RESULT])
    expect(products).toHaveLength(1)
    expect(products[0]).toMatchObject({
      resultSearchTermScrapedProductId: "r1",
      title: "Blazer bege",
      searchTerm: "blazer casual",
      marketplace: "enjoei",
    })
  })

  it("maps at most one listed product per result id", () => {
    const chosen = parseAnalyzeResultsLlmOutput(
      JSON.stringify([
        { searchTermScrapedProductId: "s1", resultId: "r1" },
        { searchTermScrapedProductId: "s2", resultId: "r1" },
      ]),
    )
    expect(chosen).toEqual([{ searchTermScrapedProductId: "s1", resultId: "r1" }])

    const products = buildChosenProductInserts(
      [
        { searchTermScrapedProductId: "s1", resultId: "r1" },
        { searchTermScrapedProductId: "s2", resultId: "r1" },
      ],
      [RESULT],
    )
    expect(products).toHaveLength(1)
    expect(products[0]?.resultSearchTermScrapedProductId).toBe("r1")
  })

  it("swapForPanorama does not begin a transaction when the insert list is empty", async () => {
    const repo = new SqlScrapedProductsSwapRepository(mocks.writeDb as never)
    await repo.swapForPanorama({
      wardrobePanoramaId: "p1",
      products: [],
      keepSearchTermIds: ["s1"],
    })
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("load-context reads unprocessed results and never deletes registers", async () => {
    mocks.writeDb.mockImplementation((strings: TemplateStringsArray) => {
      const query = sqlText(strings)
      if (query.includes("FROM wardrobe_panorama")) {
        return Promise.resolve([{ id: "p1", user_id: "user-1", content: "## panorama" }])
      }
      if (query.includes("app_preferences")) return Promise.resolve([{ name: "Português (BR)" }])
      if (query.includes("weekly_outfit_preferences")) return Promise.resolve([])
      if (query.includes("FROM results_search_terms_scraped_products")) {
        return Promise.resolve([
          {
            result_id: "r1",
            search_term_id: "s1",
            json_result: RESULT.jsonResult,
            json_search: RESULT.jsonSearch,
            marketplace: "enjoei",
          },
        ])
      }
      return Promise.resolve([])
    })

    const ctx = await loadAnalyzeContextStep("p1")
    expect(ctx.results).toHaveLength(1)
    expect(ctx.results[0]?.searchTermId).toBe("s1")

    const readSql = mocks.writeDb.mock.calls
      .flatMap((call) => {
        const first = call[0]
        if (Array.isArray(first)) return first.filter((s): s is string => typeof s === "string")
        return []
      })
      .join(" ")
    expect(readSql).not.toMatch(/DELETE/i)
    expect(mocks.begin).not.toHaveBeenCalled()
  })
})
