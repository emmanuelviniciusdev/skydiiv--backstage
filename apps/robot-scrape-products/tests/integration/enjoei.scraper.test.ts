import { describe, expect, it, vi } from "vitest"
import type { SearchParams } from "../../src/domain/entities/search-params.js"
import type {
  BrowserFactoryPort,
  BrowserPage,
  BrowserSession,
} from "../../src/domain/ports/browser-factory.port.js"
import type { DelayPort } from "../../src/domain/ports/delay.port.js"
import type { ProxyRotatorPort } from "../../src/domain/ports/proxy-rotator.port.js"
import type { Logger } from "../../src/domain/ports/logger.port.js"
import {
  EnjoeiScraper,
  type EnjoeiDomProduct,
  type EnjoeiProductSizeLookup,
} from "../../src/infrastructure/scraping/marketplaces/enjoei.scraper.js"
import { enjoeiProductIdFromUrl } from "../../src/infrastructure/scraping/marketplaces/enjoei-search-url.js"
import { searchParams } from "../helpers/search-params.js"

function silentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

type Card = Partial<EnjoeiDomProduct> & { url: string }

function card(url: string, overrides: Partial<EnjoeiDomProduct> = {}): Card {
  return {
    title: `item ${url}`,
    price: 42,
    currency: "BRL",
    imageUrl: "https://img.example/1.jpg",
    size: null,
    ...overrides,
    url,
  }
}

interface FakeBrowser {
  factory: BrowserFactoryPort
  /** Every URL passed to `goto`, in order. */
  visitedUrls: string[]
  /** Only the listing (`/p/`) URLs, in order — i.e. the fallback path. */
  visitedListings: string[]
  /** Product ids requested per product-JSON batch, in order. */
  jsonBatches: string[][]
}

/**
 * Fake browser covering the three things the scraper asks of a page: the search
 * card extraction, the product-JSON size batch (which runs *in* the search
 * page), and the listing-page fallback.
 *
 * The two size sources are configured separately so the fallback can be driven
 * independently of the JSON: `listingSizes` is what the product JSON publishes,
 * `listingPageSizes` is what the listing page's DOM publishes.
 */
function fakeBrowser(options: {
  /** Cards per search navigation, in order. A single array is reused. */
  cards?: Card[] | Card[][]
  /** Size published by each listing URL's product JSON. Missing → `{ size: null }`. */
  listingSizes?: Record<string, string | null>
  /** Listing URLs whose product JSON lookup fails, forcing the fallback. */
  jsonErrors?: string[]
  /** Size published by each listing URL's *page*, used by the fallback. */
  listingPageSizes?: Record<string, string | null>
  onLaunch?: (options?: { proxyUrl?: string }) => void
}): FakeBrowser {
  const visitedUrls: string[] = []
  const visitedListings: string[] = []
  const jsonBatches: string[][] = []
  const cardPages = Array.isArray(options.cards?.[0])
    ? (options.cards as Card[][])
    : undefined
  let searchCount = 0

  const allCards = (cardPages ?? [(options.cards as Card[] | undefined) ?? []]).flat()
  const urlById = new Map<string, string>()
  for (const url of [
    ...allCards.map((c) => c.url),
    ...Object.keys(options.listingSizes ?? {}),
    ...(options.jsonErrors ?? []),
  ]) {
    const id = enjoeiProductIdFromUrl(url)
    if (id) urlById.set(id, url)
  }

  const lookupById = (id: string): EnjoeiProductSizeLookup => {
    const url = urlById.get(id)
    if (!url) return { error: "unknown product id" }
    if (options.jsonErrors?.includes(url)) return { error: "HTTP 404" }
    return { size: options.listingSizes?.[url] ?? null }
  }

  const newPage = (): BrowserPage => {
    let currentUrl = ""
    let isListing = false

    return {
      goto: async (url) => {
        currentUrl = url
        isListing = url.includes("/p/")
        visitedUrls.push(url)
        if (isListing) visitedListings.push(url)
      },
      content: async () => "",
      evaluate: async <T>(script: string | (() => T | Promise<T>)) => {
        if (isListing) {
          return (options.listingPageSizes?.[currentUrl] ?? null) as T
        }

        const source = String(script)
        if (source.includes("v2.json")) {
          const ids = JSON.parse(
            /const ids = (\[[^\]]*\]);/.exec(source)?.[1] ?? "[]",
          ) as string[]
          jsonBatches.push(ids)
          return Object.fromEntries(ids.map((id) => [id, lookupById(id)])) as T
        }

        const page = cardPages
          ? (cardPages[searchCount] ?? [])
          : ((options.cards as Card[] | undefined) ?? [])
        searchCount += 1
        return page as T
      },
      close: async () => {},
    }
  }

  const session: BrowserSession = {
    newPage: async () => newPage(),
    close: async () => {},
  }

  return {
    factory: {
      launch: async (launchOptions) => {
        options.onLaunch?.(launchOptions)
        return session
      },
    },
    visitedUrls,
    visitedListings,
    jsonBatches,
  }
}

function scraperWith(
  browser: FakeBrowser,
  overrides: {
    delay?: DelayPort
    proxyRotator?: ProxyRotatorPort
    logger?: Logger
    buildSearchUrl?: (params: SearchParams) => string
  } = {},
): EnjoeiScraper {
  return new EnjoeiScraper({
    browserFactory: browser.factory,
    delay: overrides.delay ?? { humanDelay: async () => {} },
    proxyRotator:
      overrides.proxyRotator ?? {
        isEnabled: () => false,
        next: () => {
          throw new Error("unused")
        },
      },
    logger: overrides.logger ?? silentLogger(),
    ...(overrides.buildSearchUrl ? { buildSearchUrl: overrides.buildSearchUrl } : {}),
  })
}

describe("EnjoeiScraper (integration with fake browser)", () => {
  it("returns the products of each search params entry", async () => {
    const delayCalls: number[] = []
    const delay: DelayPort = {
      humanDelay: async () => {
        delayCalls.push(Date.now())
      },
    }

    const browser = fakeBrowser({
      cards: [
        [
          card("https://www.enjoei.com.br/p/jaqueta-youcom-azul-pp-143818536", {
            title: "jaqueta youcom azul pp",
            price: 51,
          }),
        ],
        [
          card("https://www.enjoei.com.br/p/vestido-floral-991", {
            title: "vestido floral midi",
            price: 89.9,
          }),
        ],
      ],
    })

    const scraper = scraperWith(browser, {
      delay,
      buildSearchUrl: (params) => `https://www.enjoei.com.br/s/?q=${params.searchTerm}`,
    })

    const products = await scraper.scrape({
      searchParams: [searchParams("jaqueta jeans youcom"), searchParams("vestido floral")],
      userId: "user-9",
    })

    expect(browser.visitedUrls).toEqual([
      "https://www.enjoei.com.br/s/?q=jaqueta jeans youcom",
      "https://www.enjoei.com.br/s/?q=vestido floral",
    ])
    expect(delayCalls.length).toBe(3)
    expect(products).toHaveLength(2)
    expect(products[0]).toMatchObject({
      title: "jaqueta youcom azul pp",
      price: 51,
      currency: "BRL",
      searchTerm: "jaqueta jeans youcom",
    })
    expect(products[1]?.searchTerm).toBe("vestido floral")
  })

  it("uses the default URL builder with gender and size filters", async () => {
    const browser = fakeBrowser({ cards: [] })
    const scraper = scraperWith(browser)

    await scraper.scrape({
      searchParams: [
        searchParams("camiseta", {
          gender: "Female",
          topSize: "M",
          bottomSize: "40",
          footSize: "38",
        }),
      ],
      userId: "u1",
    })

    expect(browser.visitedUrls).toEqual([
      "https://www.enjoei.com.br/s/?q=camiseta&d=feminino&sc=m&sw=40&ss=38",
    ])
  })

  it("skips an entry when no product card is found", async () => {
    const browser = fakeBrowser({ cards: [] })
    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("produto inexistente xyz")],
      userId: "u1",
    })

    expect(products).toEqual([])
  })

  it("passes rotated proxy URL to the browser factory when proxy rotation is on", async () => {
    const onLaunch = vi.fn()
    const browser = fakeBrowser({ cards: [], onLaunch })

    await scraperWith(browser, {
      proxyRotator: {
        isEnabled: () => true,
        next: () => ({ proxyUrl: "socks5://proxy-a.example.com:1080" }),
      },
    }).scrape({ searchParams: [searchParams("saia")], userId: "u1" })

    expect(onLaunch).toHaveBeenCalledWith({
      proxyUrl: "socks5://proxy-a.example.com:1080",
    })
  })

  it("returns multiple cards for one search and caps at 10", async () => {
    const browser = fakeBrowser({
      cards: Array.from({ length: 12 }, (_, i) =>
        card(`https://www.enjoei.com.br/p/item-${i}-${100 + i}`, { title: `item ${i}` }),
      ),
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("blazer")],
      userId: "u1",
    })

    expect(products).toHaveLength(10)
    expect(products[0]?.title).toBe("item 0")
    expect(products[9]?.title).toBe("item 9")
  })

  it("confirms no sizes at all when the search asks for no size", async () => {
    const browser = fakeBrowser({
      cards: [card("https://www.enjoei.com.br/p/cinto-1-501", { size: "Único" })],
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("cinto couro")],
      userId: "u1",
    })

    expect(browser.jsonBatches).toEqual([])
    expect(browser.visitedListings).toEqual([])
    expect(products).toHaveLength(1)
    expect(products[0]?.size).toBe("Único")
  })

  it("keeps only listings whose product JSON publishes a requested size", async () => {
    const browser = fakeBrowser({
      cards: [
        card("https://www.enjoei.com.br/p/blusa-m-101", { size: "M" }),
        card("https://www.enjoei.com.br/p/blusa-gg-102", { size: "GG" }),
        card("https://www.enjoei.com.br/p/blusa-g-103", { size: "G" }),
      ],
      listingSizes: {
        "https://www.enjoei.com.br/p/blusa-m-101": "M",
        "https://www.enjoei.com.br/p/blusa-g-103": "G",
      },
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("blusa", { topSize: "M, G" })],
      userId: "u1",
    })

    // The GG card is never looked up — its card size already fails the request.
    expect(browser.jsonBatches).toEqual([["101", "103"]])
    expect(browser.visitedListings).toEqual([])
    expect(products.map((p) => [p.url, p.size])).toEqual([
      ["https://www.enjoei.com.br/p/blusa-m-101", "M"],
      ["https://www.enjoei.com.br/p/blusa-g-103", "G"],
    ])
  })

  it("trusts the product JSON over the card when the two disagree", async () => {
    const browser = fakeBrowser({
      cards: [
        card("https://www.enjoei.com.br/p/lies-about-size-201", { size: "M" }),
        card("https://www.enjoei.com.br/p/unknown-card-size-202", { size: null }),
      ],
      listingSizes: {
        "https://www.enjoei.com.br/p/lies-about-size-201": "GG",
        "https://www.enjoei.com.br/p/unknown-card-size-202": "M",
      },
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("blusa", { topSize: "M" })],
      userId: "u1",
    })

    expect(products.map((p) => p.url)).toEqual([
      "https://www.enjoei.com.br/p/unknown-card-size-202",
    ])
    expect(products[0]?.size).toBe("M")
  })

  it("drops a listing whose product JSON publishes no size", async () => {
    const browser = fakeBrowser({
      cards: [card("https://www.enjoei.com.br/p/sem-tamanho-301", { size: null })],
      listingSizes: {},
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("tênis", { footSize: "38" })],
      userId: "u1",
    })

    expect(browser.jsonBatches).toEqual([["301"]])
    expect(browser.visitedListings).toEqual([])
    expect(products).toEqual([])
  })

  it("fills the ten slots from later cards when the first ones are the wrong size", async () => {
    const wrong = Array.from({ length: 8 }, (_, i) =>
      card(`https://www.enjoei.com.br/p/wrong-${i}-${400 + i}`, { size: "PP" }),
    )
    const right = Array.from({ length: 10 }, (_, i) =>
      card(`https://www.enjoei.com.br/p/right-${i}-${500 + i}`, { size: "M" }),
    )
    const listingSizes = Object.fromEntries(right.map((c) => [c.url, "M"] as const))

    const browser = fakeBrowser({ cards: [...wrong, ...right], listingSizes })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("camiseta", { topSize: "M" })],
      userId: "u1",
    })

    expect(products).toHaveLength(10)
    expect(products.every((p) => p.size === "M")).toBe(true)
    expect(browser.visitedListings).toEqual([])
  })

  it("looks sizes up in batches of five", async () => {
    const cards = Array.from({ length: 10 }, (_, i) =>
      card(`https://www.enjoei.com.br/p/item-${i}-${600 + i}`, { size: "M" }),
    )
    const browser = fakeBrowser({
      cards,
      listingSizes: Object.fromEntries(cards.map((c) => [c.url, "M"] as const)),
    })

    await scraperWith(browser).scrape({
      searchParams: [searchParams("camiseta", { topSize: "M" })],
      userId: "u1",
    })

    expect(browser.jsonBatches).toEqual([
      ["600", "601", "602", "603", "604"],
      ["605", "606", "607", "608", "609"],
    ])
  })

  it("stops confirming sizes at the check cap", async () => {
    const warn = vi.fn()
    const logger: Logger = { ...silentLogger(), warn }
    const browser = fakeBrowser({
      cards: Array.from({ length: 40 }, (_, i) =>
        card(`https://www.enjoei.com.br/p/unknown-${i}-${700 + i}`, { size: null }),
      ),
      listingSizes: {},
    })

    const products = await scraperWith(browser, { logger }).scrape({
      searchParams: [searchParams("camiseta", { topSize: "M" })],
      userId: "u1",
    })

    expect(products).toEqual([])
    expect(browser.jsonBatches.flat()).toHaveLength(30)
    expect(browser.visitedListings).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      "Stopped confirming Enjoei sizes at the check cap",
      expect.objectContaining({ searchTerm: "camiseta" }),
    )
  })

  it("falls back to the listing page when a product JSON cannot be read", async () => {
    const browser = fakeBrowser({
      cards: [
        card("https://www.enjoei.com.br/p/gone-801", { size: "M" }),
        card("https://www.enjoei.com.br/p/fine-802", { size: "M" }),
      ],
      jsonErrors: ["https://www.enjoei.com.br/p/gone-801"],
      listingSizes: { "https://www.enjoei.com.br/p/fine-802": "M" },
      listingPageSizes: { "https://www.enjoei.com.br/p/gone-801": "M" },
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("blusa", { topSize: "M" })],
      userId: "u1",
    })

    expect(browser.visitedListings).toEqual(["https://www.enjoei.com.br/p/gone-801"])
    expect(products.map((p) => [p.url, p.size])).toEqual([
      ["https://www.enjoei.com.br/p/gone-801", "M"],
      ["https://www.enjoei.com.br/p/fine-802", "M"],
    ])
  })

  it("falls back for a listing URL that carries no product id", async () => {
    const browser = fakeBrowser({
      cards: [card("https://www.enjoei.com.br/p/no-id-here", { size: "M" })],
      listingPageSizes: { "https://www.enjoei.com.br/p/no-id-here": "M" },
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("blusa", { topSize: "M" })],
      userId: "u1",
    })

    expect(browser.jsonBatches).toEqual([])
    expect(browser.visitedListings).toEqual(["https://www.enjoei.com.br/p/no-id-here"])
    expect(products.map((p) => p.size)).toEqual(["M"])
  })

  it("logs an error when every product-JSON lookup falls back", async () => {
    const error = vi.fn()
    const logger: Logger = { ...silentLogger(), error }
    const urls = [
      "https://www.enjoei.com.br/p/a-901",
      "https://www.enjoei.com.br/p/b-902",
    ]
    const browser = fakeBrowser({
      cards: urls.map((url) => card(url, { size: "M" })),
      jsonErrors: urls,
      listingPageSizes: Object.fromEntries(urls.map((url) => [url, "M"] as const)),
    })

    const products = await scraperWith(browser, { logger }).scrape({
      searchParams: [searchParams("blusa", { topSize: "M" })],
      userId: "u1",
    })

    expect(products).toHaveLength(2)
    expect(error).toHaveBeenCalledWith(
      "Every Enjoei product-JSON lookup failed — the endpoint or its shape has likely changed",
      expect.objectContaining({ searchTerm: "blusa", checked: 2 }),
    )
  })
})
