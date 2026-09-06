import type { ScrapedProduct } from "../../../domain/entities/scraped-product.js"
import type { SearchParams } from "../../../domain/entities/search-params.js"
import type {
  BrowserFactoryPort,
  BrowserPage,
  BrowserSession,
} from "../../../domain/ports/browser-factory.port.js"
import type { DelayPort } from "../../../domain/ports/delay.port.js"
import type { Logger } from "../../../domain/ports/logger.port.js"
import type { ProxyRotatorPort } from "../../../domain/ports/proxy-rotator.port.js"
import type {
  MarketplaceScrapeInput,
  MarketplaceScraperPort,
} from "../../../domain/ports/marketplace-scraper.port.js"
import {
  buildEnjoeiSearchUrl,
  enjoeiProductIdFromUrl,
  matchesRequestedEnjoeiSize,
  requestedEnjoeiSizeSlugs,
} from "./enjoei-search-url.js"

export interface EnjoeiScraperDeps {
  browserFactory: BrowserFactoryPort
  delay: DelayPort
  proxyRotator: ProxyRotatorPort
  logger: Logger
  /** Injectable for tests — defaults to building the public Enjoei search URL. */
  buildSearchUrl?: (params: SearchParams) => string
}

export interface EnjoeiDomProduct {
  title: string
  price: number | null
  currency: string | null
  url: string
  imageUrl: string | null
  size: string | null
}

/** Listings persisted per search params entry. */
const MAX_PRODUCTS_PER_SEARCH = 10

/**
 * Upper bound on size confirmations for one search. Enjoei renders ~30 cards
 * per page, so this lets every card on the page be checked while still bounding
 * the work when the card selector breaks and no card can be pre-filtered.
 */
const MAX_SIZE_CHECKS_PER_SEARCH = 30

/** Cards read from one search results page. */
const MAX_CARDS_PER_SEARCH = 60

/** Product-JSON lookups issued per `page.evaluate` fan-out. */
const SIZE_LOOKUP_CONCURRENCY = 5

/** How long the listing page is polled for its hydrated "tamanho" value. */
const LISTING_SIZE_TIMEOUT_MS = 8_000

/** Host serving the per-listing JSON view used to confirm sizes. */
export const ENJOEI_PRODUCT_JSON_ORIGIN = "https://pages.enjoei.com.br"

/**
 * Browser-side extractor for the product cards under Enjoei's default
 * "mais relevantes" ranking. Title/price live in dedicated nodes — never use
 * the image-link textContent (that often is just the discount badge, e.g. "7%").
 *
 * The card size is a hint used to skip listings before opening them; the size
 * that gets persisted is always read from the listing's own record.
 */
export const ENJOEI_EXTRACT_PRODUCTS = `(() => {
  const cards = Array.from(document.querySelectorAll(".c-product-card")).slice(0, ${MAX_CARDS_PER_SEARCH});
  const products = [];
  for (const card of cards) {
    const anchor = card.querySelector('a[href*="/p/"]');
    const href = anchor ? anchor.getAttribute("href") || "" : "";
    if (!href) continue;

    const titleEl = card.querySelector('[data-test="div-nome-prod"], .c-product-card__title');
    const imgEl = card.querySelector('img[data-test="image-prod"], .c-product-card__img, img');
    let title = (titleEl && titleEl.textContent ? titleEl.textContent : "").trim();
    if (!title && imgEl) {
      title = (imgEl.getAttribute("alt") || "").trim();
    }
    if (!title || /^\\d+%$/.test(title)) continue;

    const priceRoot = card.querySelector('[data-test="div-preco"], .c-product-card__price');
    let price = null;
    if (priceRoot) {
      const discount = priceRoot.querySelector(".c-product-card__price-discount");
      const clone = priceRoot.cloneNode(true);
      if (discount && clone.querySelector) {
        const discountClone = clone.querySelector(".c-product-card__price-discount");
        if (discountClone) discountClone.remove();
      }
      const priceText = (clone.textContent || "").replace(/\\s/g, "");
      const priceMatch = priceText.match(/R\\$?\\s*([\\d.,]+)/i) || priceText.match(/([\\d.,]+)/);
      if (priceMatch && priceMatch[1]) {
        const raw = priceMatch[1];
        const normalized = raw.includes(",")
          ? raw.replace(/\\./g, "").replace(",", ".")
          : raw;
        const parsed = Number.parseFloat(normalized);
        price = Number.isFinite(parsed) ? parsed : null;
      }
    }

    const sizeEl = card.querySelector(".c-product-card__size, .c-product-card__size-wrapper");
    const sizeText = (sizeEl && sizeEl.textContent ? sizeEl.textContent : "").trim();

    const imageUrl = imgEl
      ? imgEl.getAttribute("src") || imgEl.getAttribute("data-src")
      : null;

    const absoluteUrl = href.startsWith("http")
      ? href.split("?")[0]
      : "https://www.enjoei.com.br" + (href.startsWith("/") ? "" : "/") + href.split("?")[0];

    products.push({
      title: title,
      price: price,
      currency: price !== null ? "BRL" : null,
      url: absoluteUrl,
      imageUrl: imageUrl,
      size: sizeText || null,
    });
  }
  return products;
})()`

/** One entry of the product-size batch: either a size, or why there is none. */
export interface EnjoeiProductSizeLookup {
  /** Present when the lookup succeeded. `null` means the listing has no size. */
  size?: string | null
  /** Present when the listing could not be read, or lost its `size` field. */
  error?: string
}

/**
 * Browser-side batch reader for the authoritative size of several listings,
 * from `pages.enjoei.com.br/products/{id}/v2.json`.
 *
 * This runs inside the *search results* page rather than against a listing
 * page: that host answers with
 * `access-control-allow-origin: https://www.enjoei.com.br` and nothing else
 * (a foreign origin gets `null`), so the search page is the only context where
 * the fetch is permitted — and it inherits that page's fingerprint, cookies
 * and proxy for free.
 *
 * A missing `size` key is reported as an error rather than as "no size": the
 * endpoint is undocumented, and the two cases have to be distinguished so a
 * shape change falls back to the listing page instead of silently discarding
 * every candidate. A listing with no size set answers `{"size": null}`, with
 * the key present.
 */
export function enjoeiReadProductSizesScript(productIds: string[]): string {
  return `(async () => {
  const ids = ${JSON.stringify(productIds)};
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const response = await fetch(
        "${ENJOEI_PRODUCT_JSON_ORIGIN}/products/" + id + "/v2.json",
        { headers: { accept: "application/json" }, credentials: "omit" },
      );
      if (!response.ok) {
        out[id] = { error: "HTTP " + response.status };
        return;
      }
      const body = await response.json();
      if (!body || typeof body !== "object" || !("size" in body)) {
        out[id] = { error: "no size field in the product JSON" };
        return;
      }
      out[id] = {
        size: typeof body.size === "string" && body.size.trim() ? body.size.trim() : null,
      };
    } catch (err) {
      out[id] = { error: err && err.message ? String(err.message) : String(err) };
    }
  }));
  return out;
})()`
}

/**
 * Browser-side reader for the authoritative size on an Enjoei listing page
 * (the "tamanho" info box). The value is hydrated client-side, so it is polled.
 *
 * This is the fallback for when the product JSON above cannot be read; it is
 * the slow path (one navigation per listing) but depends only on the same DOM
 * contract as the search cards.
 */
export function enjoeiReadListingSizeScript(timeoutMs: number): string {
  return `(async () => {
  const read = () => {
    const el = document.querySelector('[data-testid="product-size-value"]');
    const text = el && el.textContent ? el.textContent.trim() : "";
    return text || null;
  };
  const deadline = Date.now() + ${timeoutMs};
  let size = read();
  while (!size && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    size = read();
  }
  return size;
})()`
}

const ENJOEI_READ_LISTING_SIZE = enjoeiReadListingSizeScript(LISTING_SIZE_TIMEOUT_MS)

/**
 * Marketplace scraper for Enjoei (Brazilian second-hand clothing).
 *
 * Returns at most 10 products per search params entry under the default
 * "mais relevantes" ranking, with optional gender/size/brand filters.
 *
 * When a search asks for sizes, every returned listing has its size read from
 * that listing's own record and checked against the request — Enjoei's URL
 * filters are not trusted on their own. See docs/ENJOEI_SCRAPING.md.
 */
export class EnjoeiScraper implements MarketplaceScraperPort {
  readonly marketplace = "enjoei"

  private readonly buildSearchUrl: (params: SearchParams) => string

  constructor(private readonly deps: EnjoeiScraperDeps) {
    this.buildSearchUrl = deps.buildSearchUrl ?? buildEnjoeiSearchUrl
  }

  async scrape(input: MarketplaceScrapeInput): Promise<ScrapedProduct[]> {
    const proxy = this.deps.proxyRotator.isEnabled()
      ? this.deps.proxyRotator.next()
      : null

    const browser = await this.deps.browserFactory.launch(
      proxy ? { proxyUrl: proxy.proxyUrl } : undefined,
    )
    const products: ScrapedProduct[] = []

    try {
      for (let i = 0; i < input.searchParams.length; i++) {
        const params = input.searchParams[i]!

        if (i > 0) {
          await this.deps.delay.humanDelay()
        }

        this.deps.logger.info("Scraping Enjoei search", {
          userId: input.userId,
          searchTerm: params.searchTerm,
          gender: params.gender,
          topSize: params.topSize,
          bottomSize: params.bottomSize,
          footSize: params.footSize,
          brand: params.brand,
          requestedSizes: requestedEnjoeiSizeSlugs(params),
        })

        products.push(...(await this.scrapeSearchParams(browser, params)))
      }
    } finally {
      await browser.close()
    }

    this.deps.logger.debug("Enjoei scrape output", {
      userId: input.userId,
      searchParams: input.searchParams,
      productCount: products.length,
      products,
    })

    return products
  }

  /**
   * Scrapes one search params entry.
   *
   * The search page is kept open for the whole entry, because the size
   * confirmation below runs its fetches from inside it.
   */
  private async scrapeSearchParams(
    browser: BrowserSession,
    params: SearchParams,
  ): Promise<ScrapedProduct[]> {
    const requestedSizes = requestedEnjoeiSizeSlugs(params)
    const url = this.buildSearchUrl(params)
    const page = await browser.newPage()

    try {
      const listings = await this.readSearchResults(page, url)

      if (listings.length === 0) {
        this.deps.logger.warn("No relevant Enjoei products found", {
          searchTerm: params.searchTerm,
          url,
        })
        return []
      }

      const selected =
        requestedSizes.length === 0
          ? listings.slice(0, MAX_PRODUCTS_PER_SEARCH)
          : await this.selectBySize(browser, page, listings, requestedSizes, params)

      this.deps.logger.debug("Enjoei search scrape output", {
        searchTerm: params.searchTerm,
        cardCount: listings.length,
        productCount: selected.length,
      })

      return selected.map((listing) => ({
        marketplace: this.marketplace,
        title: listing.title,
        price: listing.price,
        currency: listing.currency,
        url: listing.url,
        imageUrl: listing.imageUrl,
        size: listing.size ?? null,
        searchTerm: params.searchTerm,
        searchParams: params,
      }))
    } finally {
      await page.close()
    }
  }

  private async readSearchResults(
    page: BrowserPage,
    url: string,
  ): Promise<EnjoeiDomProduct[]> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })

    // Wait for product cards to hydrate past the skeleton state.
    await this.deps.delay.humanDelay()

    const extracted = await page.evaluate<EnjoeiDomProduct[]>(ENJOEI_EXTRACT_PRODUCTS)
    return Array.isArray(extracted) ? extracted : []
  }

  /**
   * Keeps only listings whose own record publishes a requested size.
   *
   * Cards whose size could not be read are still checked — the listing itself
   * is the authority, so a changed card layout costs extra lookups instead of
   * silently letting wrong sizes through.
   */
  private async selectBySize(
    browser: BrowserSession,
    searchPage: BrowserPage,
    listings: EnjoeiDomProduct[],
    requestedSizes: string[],
    params: SearchParams,
  ): Promise<EnjoeiDomProduct[]> {
    const eligible = listings.filter(
      (listing) =>
        !listing.size || matchesRequestedEnjoeiSize(requestedSizes, listing.size),
    )
    const candidates = eligible.slice(0, MAX_SIZE_CHECKS_PER_SEARCH)

    const selected: EnjoeiDomProduct[] = []
    const stats = { checked: 0, discarded: 0, fallbacks: 0 }

    for (
      let i = 0;
      i < candidates.length && selected.length < MAX_PRODUCTS_PER_SEARCH;
      i += SIZE_LOOKUP_CONCURRENCY
    ) {
      const chunk = candidates.slice(i, i + SIZE_LOOKUP_CONCURRENCY)

      await this.deps.delay.humanDelay()
      const sizes = await this.resolveSizes(browser, searchPage, chunk, stats)

      for (const candidate of chunk) {
        if (selected.length >= MAX_PRODUCTS_PER_SEARCH) break

        stats.checked += 1
        const size = sizes.get(candidate.url) ?? null

        if (!matchesRequestedEnjoeiSize(requestedSizes, size)) {
          stats.discarded += 1
          this.deps.logger.debug("Discarded Enjoei listing with a non-requested size", {
            searchTerm: params.searchTerm,
            requestedSizes,
            listingSize: size,
            url: candidate.url,
          })
          continue
        }

        selected.push({ ...candidate, size })
      }
    }

    if (candidates.length < eligible.length && selected.length < MAX_PRODUCTS_PER_SEARCH) {
      this.deps.logger.warn("Stopped confirming Enjoei sizes at the check cap", {
        searchTerm: params.searchTerm,
        requestedSizes,
        checks: stats.checked,
        selected: selected.length,
      })
    }

    // Every lookup falling back means the JSON endpoint, not one listing, is
    // the problem. Left silent it would look like "nothing in the right size".
    if (stats.checked > 0 && stats.fallbacks === stats.checked) {
      this.deps.logger.error(
        "Every Enjoei product-JSON lookup failed — the endpoint or its shape has likely changed",
        { searchTerm: params.searchTerm, checked: stats.checked },
      )
    }

    this.deps.logger.info("Confirmed Enjoei listing sizes", {
      searchTerm: params.searchTerm,
      requestedSizes,
      cardCount: listings.length,
      candidateCount: eligible.length,
      checked: stats.checked,
      kept: selected.length,
      discarded: stats.discarded,
      listingPageFallbacks: stats.fallbacks,
    })

    return selected
  }

  /**
   * Sizes for one chunk of candidates, keyed by listing URL.
   *
   * The chunk is resolved as a single `fetch` fan-out inside the search page
   * (see `enjoeiReadProductSizesScript`). A candidate the batch could not
   * answer falls back to opening its listing page, so an endpoint change costs
   * navigations rather than emptying the results.
   */
  private async resolveSizes(
    browser: BrowserSession,
    searchPage: BrowserPage,
    chunk: EnjoeiDomProduct[],
    stats: { fallbacks: number },
  ): Promise<Map<string, string | null>> {
    const idByUrl = new Map<string, string>()
    for (const candidate of chunk) {
      const id = enjoeiProductIdFromUrl(candidate.url)
      if (id) idByUrl.set(candidate.url, id)
    }

    let lookups: Record<string, EnjoeiProductSizeLookup> = {}
    const ids = [...new Set(idByUrl.values())]

    if (ids.length > 0) {
      try {
        lookups =
          (await searchPage.evaluate<Record<string, EnjoeiProductSizeLookup>>(
            enjoeiReadProductSizesScript(ids),
          )) ?? {}
      } catch (err) {
        this.deps.logger.warn("Enjoei product-size batch failed", {
          idCount: ids.length,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const sizes = new Map<string, string | null>()

    for (const candidate of chunk) {
      const id = idByUrl.get(candidate.url)
      const lookup = id ? lookups[id] : undefined

      if (lookup && !lookup.error && "size" in lookup) {
        sizes.set(candidate.url, lookup.size ?? null)
        continue
      }

      this.deps.logger.warn(
        "Enjoei product JSON gave no size — falling back to the listing page",
        {
          url: candidate.url,
          reason:
            lookup?.error ??
            (id ? "missing from the batch response" : "no product id in the URL"),
        },
      )

      stats.fallbacks += 1
      await this.deps.delay.humanDelay()
      sizes.set(candidate.url, await this.readListingSize(browser, candidate.url))
    }

    return sizes
  }

  private async readListingSize(
    browser: BrowserSession,
    url: string,
  ): Promise<string | null> {
    const page = await browser.newPage()
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
      const size = await page.evaluate<string | null>(ENJOEI_READ_LISTING_SIZE)
      return typeof size === "string" && size.trim() ? size.trim() : null
    } catch (err) {
      this.deps.logger.warn("Failed to read the size on an Enjoei listing page", {
        url,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    } finally {
      await page.close()
    }
  }
}
