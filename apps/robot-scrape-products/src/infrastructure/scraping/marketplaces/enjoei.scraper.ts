import type { ScrapedProduct } from "../../../domain/entities/scraped-product.js"
import type { SearchParams } from "../../../domain/entities/search-params.js"
import type {
  BrowserFactoryPort,
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
 * Upper bound on listing pages opened to confirm a size for one search. Enjoei
 * renders 30 cards per page; the cap keeps a broken card selector from turning
 * one search into 30 navigations.
 */
const MAX_SIZE_CHECKS_PER_SEARCH = 20

/** Cards read from one search results page. */
const MAX_CARDS_PER_SEARCH = 60

/** How long the listing page is polled for its hydrated "tamanho" value. */
const LISTING_SIZE_TIMEOUT_MS = 8_000

/**
 * Browser-side extractor for the product cards under Enjoei's default
 * "mais relevantes" ranking. Title/price live in dedicated nodes — never use
 * the image-link textContent (that often is just the discount badge, e.g. "7%").
 *
 * The card size is a hint used to skip listings before opening them; the size
 * that gets persisted is always read from the listing page.
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

/**
 * Browser-side reader for the authoritative size on an Enjoei listing page
 * (the "tamanho" info box). The value is hydrated client-side, so it is polled.
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
 * its own listing page and checked against the request — Enjoei's URL filters
 * are not trusted on their own. See docs/ENJOEI_SCRAPING.md.
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

        const requestedSizes = requestedEnjoeiSizeSlugs(params)

        this.deps.logger.info("Scraping Enjoei search", {
          userId: input.userId,
          searchTerm: params.searchTerm,
          gender: params.gender,
          topSize: params.topSize,
          bottomSize: params.bottomSize,
          footSize: params.footSize,
          brand: params.brand,
          requestedSizes,
        })

        const url = this.buildSearchUrl(params)
        const listings = await this.readSearchResults(browser, url)

        if (listings.length === 0) {
          this.deps.logger.warn("No relevant Enjoei products found", {
            searchTerm: params.searchTerm,
            url,
          })
          continue
        }

        const selected =
          requestedSizes.length === 0
            ? listings.slice(0, MAX_PRODUCTS_PER_SEARCH)
            : await this.selectBySize(browser, listings, requestedSizes, params)

        for (const listing of selected) {
          products.push({
            marketplace: this.marketplace,
            title: listing.title,
            price: listing.price,
            currency: listing.currency,
            url: listing.url,
            imageUrl: listing.imageUrl,
            size: listing.size ?? null,
            searchTerm: params.searchTerm,
            searchParams: params,
          })
        }

        this.deps.logger.debug("Enjoei search scrape output", {
          searchTerm: params.searchTerm,
          cardCount: listings.length,
          productCount: selected.length,
        })
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

  private async readSearchResults(
    browser: BrowserSession,
    url: string,
  ): Promise<EnjoeiDomProduct[]> {
    const page = await browser.newPage()
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })

      // Wait for product cards to hydrate past the skeleton state.
      await this.deps.delay.humanDelay()

      const extracted = await page.evaluate<EnjoeiDomProduct[]>(
        ENJOEI_EXTRACT_PRODUCTS,
      )
      return Array.isArray(extracted) ? extracted : []
    } finally {
      await page.close()
    }
  }

  /**
   * Keeps only listings whose own listing page publishes a requested size.
   *
   * Cards whose size could not be read are still opened — the listing page is
   * the authority, so a changed card layout costs extra navigations instead of
   * silently letting wrong sizes through.
   */
  private async selectBySize(
    browser: BrowserSession,
    listings: EnjoeiDomProduct[],
    requestedSizes: string[],
    params: SearchParams,
  ): Promise<EnjoeiDomProduct[]> {
    const candidates = listings.filter(
      (listing) =>
        !listing.size || matchesRequestedEnjoeiSize(requestedSizes, listing.size),
    )

    const selected: EnjoeiDomProduct[] = []
    let discarded = 0
    let checks = 0

    for (const candidate of candidates) {
      if (selected.length >= MAX_PRODUCTS_PER_SEARCH) break

      if (checks >= MAX_SIZE_CHECKS_PER_SEARCH) {
        this.deps.logger.warn("Stopped confirming Enjoei sizes at the check cap", {
          searchTerm: params.searchTerm,
          requestedSizes,
          checks,
          selected: selected.length,
        })
        break
      }

      checks += 1
      await this.deps.delay.humanDelay()
      const size = await this.readListingSize(browser, candidate.url)

      if (!matchesRequestedEnjoeiSize(requestedSizes, size)) {
        discarded += 1
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

    this.deps.logger.info("Confirmed Enjoei listing sizes", {
      searchTerm: params.searchTerm,
      requestedSizes,
      cardCount: listings.length,
      candidateCount: candidates.length,
      checked: checks,
      kept: selected.length,
      discarded,
    })

    return selected
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
