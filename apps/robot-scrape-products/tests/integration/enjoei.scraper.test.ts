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
} from "../../src/infrastructure/scraping/marketplaces/enjoei.scraper.js"
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
  /** Only the listing (`/p/`) URLs, in order. */
  visitedListings: string[]
}

/**
 * Fake browser that answers search pages with cards and listing pages with the
 * size published on that listing — the two page kinds the scraper navigates.
 */
function fakeBrowser(options: {
  /** Cards per search navigation, in order. A single array is reused. */
  cards?: Card[] | Card[][]
  /** Size published by each listing URL. Missing entries publish no size. */
  listingSizes?: Record<string, string | null>
  onLaunch?: (options?: { proxyUrl?: string }) => void
}): FakeBrowser {
  const visitedUrls: string[] = []
  const visitedListings: string[] = []
  const cardPages = Array.isArray(options.cards?.[0])
    ? (options.cards as Card[][])
    : undefined
  let searchCount = 0

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
      evaluate: async <T>() => {
        if (isListing) {
          return (options.listingSizes?.[currentUrl] ?? null) as T
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
          card("https://www.enjoei.com.br/p/vestido-floral", {
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
        card(`https://www.enjoei.com.br/p/item-${i}`, { title: `item ${i}` }),
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

  it("does not open listing pages when the search asks for no size", async () => {
    const browser = fakeBrowser({
      cards: [card("https://www.enjoei.com.br/p/cinto-1", { size: "Único" })],
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("cinto couro")],
      userId: "u1",
    })

    expect(browser.visitedListings).toEqual([])
    expect(products).toHaveLength(1)
    expect(products[0]?.size).toBe("Único")
  })

  it("keeps only listings whose listing page publishes a requested size", async () => {
    const browser = fakeBrowser({
      cards: [
        card("https://www.enjoei.com.br/p/blusa-m", { size: "M" }),
        card("https://www.enjoei.com.br/p/blusa-gg", { size: "GG" }),
        card("https://www.enjoei.com.br/p/blusa-g", { size: "G" }),
      ],
      listingSizes: {
        "https://www.enjoei.com.br/p/blusa-m": "M",
        "https://www.enjoei.com.br/p/blusa-g": "G",
      },
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("blusa", { topSize: "M, G" })],
      userId: "u1",
    })

    // The GG card never gets opened — its card size already fails the request.
    expect(browser.visitedListings).toEqual([
      "https://www.enjoei.com.br/p/blusa-m",
      "https://www.enjoei.com.br/p/blusa-g",
    ])
    expect(products.map((p) => [p.url, p.size])).toEqual([
      ["https://www.enjoei.com.br/p/blusa-m", "M"],
      ["https://www.enjoei.com.br/p/blusa-g", "G"],
    ])
  })

  it("trusts the listing page over the card when the two disagree", async () => {
    const browser = fakeBrowser({
      cards: [
        card("https://www.enjoei.com.br/p/lies-about-size", { size: "M" }),
        card("https://www.enjoei.com.br/p/unknown-card-size", { size: null }),
      ],
      listingSizes: {
        "https://www.enjoei.com.br/p/lies-about-size": "GG",
        "https://www.enjoei.com.br/p/unknown-card-size": "M",
      },
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("blusa", { topSize: "M" })],
      userId: "u1",
    })

    expect(products.map((p) => p.url)).toEqual([
      "https://www.enjoei.com.br/p/unknown-card-size",
    ])
    expect(products[0]?.size).toBe("M")
  })

  it("drops listings whose size cannot be read at all", async () => {
    const browser = fakeBrowser({
      cards: [card("https://www.enjoei.com.br/p/sem-tamanho", { size: null })],
      listingSizes: {},
    })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("tênis", { footSize: "38" })],
      userId: "u1",
    })

    expect(browser.visitedListings).toEqual(["https://www.enjoei.com.br/p/sem-tamanho"])
    expect(products).toEqual([])
  })

  it("fills the ten slots from later cards when the first ones are the wrong size", async () => {
    const wrong = Array.from({ length: 8 }, (_, i) =>
      card(`https://www.enjoei.com.br/p/wrong-${i}`, { size: "PP" }),
    )
    const right = Array.from({ length: 10 }, (_, i) =>
      card(`https://www.enjoei.com.br/p/right-${i}`, { size: "M" }),
    )
    const listingSizes = Object.fromEntries(
      right.map((c) => [c.url, "M"] as const),
    )

    const browser = fakeBrowser({ cards: [...wrong, ...right], listingSizes })

    const products = await scraperWith(browser).scrape({
      searchParams: [searchParams("camiseta", { topSize: "M" })],
      userId: "u1",
    })

    expect(products).toHaveLength(10)
    expect(products.every((p) => p.size === "M")).toBe(true)
    expect(browser.visitedListings).toHaveLength(10)
  })

  it("stops opening listing pages at the size-check cap", async () => {
    const warn = vi.fn()
    const logger: Logger = { ...silentLogger(), warn }
    const browser = fakeBrowser({
      cards: Array.from({ length: 40 }, (_, i) =>
        card(`https://www.enjoei.com.br/p/unknown-${i}`, { size: null }),
      ),
      listingSizes: {},
    })

    const products = await scraperWith(browser, { logger }).scrape({
      searchParams: [searchParams("camiseta", { topSize: "M" })],
      userId: "u1",
    })

    expect(products).toEqual([])
    expect(browser.visitedListings).toHaveLength(20)
    expect(warn).toHaveBeenCalledWith(
      "Stopped confirming Enjoei sizes at the check cap",
      expect.objectContaining({ searchTerm: "camiseta" }),
    )
  })
})
