// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, expect, it } from "vitest"
import {
  ENJOEI_EXTRACT_PRODUCTS,
  enjoeiReadListingSizeScript,
  type EnjoeiDomProduct,
} from "../../src/infrastructure/scraping/marketplaces/enjoei.scraper.js"

/**
 * The two browser-side scripts are the contract with Enjoei's markup. The
 * fixtures below are trimmed copies of the live DOM, so a selector that stops
 * matching fails here instead of silently returning wrong-size listings.
 */

/** Runs a browser-side script string the way `page.evaluate` would. */
function evaluateScript<T>(script: string): T {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- running the exact string shipped to page.evaluate is the point of these tests
  return new Function(`return ${script}`)() as T
}

function extract(): EnjoeiDomProduct[] {
  return evaluateScript<EnjoeiDomProduct[]>(ENJOEI_EXTRACT_PRODUCTS)
}

function readListingSize(timeoutMs = 50): Promise<string | null> {
  return evaluateScript<Promise<string | null>>(enjoeiReadListingSizeScript(timeoutMs))
}

/** Trimmed from a live `/s/` result card. */
function productCard(options: {
  href: string
  title: string
  price: string
  size?: string
  alt?: string
}): string {
  const sizeBlock =
    options.size === undefined
      ? ""
      : `<div class="c-product-card__size-wrapper"><svg></svg>
           <div class="c-product-card__size o-text -xs-brevier">
             ${options.size}
           </div></div>`

  return `
<div class="c-product-card">
  <div class="c-product-card__img-wrapper">
    <button type="button" data-test="button-yeye" class="yeah-yeah-button">7%</button>
    <a href="${options.href}">
      <div class="c-product-card__tags-container"></div>
      <picture>
        <img src="https://photos.enjoei.com.br/public/300x300/abc"
             alt="${options.alt ?? options.title}"
             data-test="image-prod" class="c-product-card__img">
      </picture>
    </a>
  </div>
  <div class="c-product-card__info-wrapper">
    <div class="c-product-card__text-wrapper has-card-actions">
      <span data-test="div-preco" class="c-product-card__price"><!----> <span class="">
          ${options.price}
        </span></span>
      <h3 data-test="div-nome-prod" class="c-product-card__title o-text">
        ${options.title}
      </h3>
      <div class="c-product-card__brand-wrapper">
        <span data-test="div-marca" class="c-product-card__brand">uvx</span>
        ${sizeBlock}
      </div>
    </div>
  </div>
</div>`
}

describe("ENJOEI_EXTRACT_PRODUCTS", () => {
  it("reads title, price, absolute URL, image and size from a live result card", () => {
    document.body.innerHTML = productCard({
      href: "/p/bermuda-masculina-uvx-jeans-branca-40-149242785?rsid=abc&rsp=1",
      title: "bermuda masculina uvx jeans branca 40",
      price: "R$ 42",
      size: "40",
    })

    expect(extract()).toEqual([
      {
        title: "bermuda masculina uvx jeans branca 40",
        price: 42,
        currency: "BRL",
        url: "https://www.enjoei.com.br/p/bermuda-masculina-uvx-jeans-branca-40-149242785",
        imageUrl: "https://photos.enjoei.com.br/public/300x300/abc",
        size: "40",
      },
    ])
  })

  it("reads letter sizes and thousand-separated prices", () => {
    document.body.innerHTML = productCard({
      href: "/p/vestido-longo-farm-123",
      title: "vestido longo farm",
      price: "R$ 1.299,90",
      size: "GG",
    })

    const [product] = extract()
    expect(product?.price).toBe(1299.9)
    expect(product?.size).toBe("GG")
  })

  it("reports a null size when the card has no size block", () => {
    document.body.innerHTML = productCard({
      href: "/p/cinto-couro-456",
      title: "cinto de couro caramelo",
      price: "R$ 60",
    })

    expect(extract()[0]?.size).toBeNull()
  })

  it("ignores the discount badge when reading the price", () => {
    document.body.innerHTML = `
<div class="c-product-card">
  <a href="/p/jaqueta-jeans-789"></a>
  <span data-test="div-preco" class="c-product-card__price">
    <span class="c-product-card__price-discount">R$ 180</span>
    <span>R$ 99</span>
  </span>
  <h3 data-test="div-nome-prod">jaqueta jeans azul</h3>
  <div class="c-product-card__size">M</div>
</div>`

    expect(extract()[0]).toMatchObject({ price: 99, size: "M" })
  })

  it("skips cards with no listing link and cards titled only with a discount badge", () => {
    document.body.innerHTML = `
<div class="c-product-card">
  <h3 data-test="div-nome-prod">sem link</h3>
</div>
${productCard({ href: "/p/badge-1", title: "7%", price: "R$ 10", size: "M" })}
${productCard({ href: "/p/valida-2", title: "blusa de linho", price: "R$ 80", size: "P" })}`

    expect(extract().map((p) => p.title)).toEqual(["blusa de linho"])
  })
})

describe("enjoeiReadListingSizeScript", () => {
  it("reads the size from the listing page info box", async () => {
    document.body.innerHTML = `
<div class="l-info-box">
  <span class="l-info-box__label" data-testid="product-size-label">
    tamanho
  </span>
  <span class="l-info-box__value" data-testid="product-size-value">
    40
  </span>
</div>`

    await expect(readListingSize()).resolves.toBe("40")
  })

  it("waits for the size to hydrate", async () => {
    document.body.innerHTML = "<div></div>"
    setTimeout(() => {
      document.body.innerHTML =
        '<span data-testid="product-size-value"> M </span>'
    }, 20)

    await expect(readListingSize(2_000)).resolves.toBe("M")
  })

  it("returns null when the listing publishes no size", async () => {
    document.body.innerHTML = '<div class="l-info-box">condição do produto usado</div>'

    await expect(readListingSize()).resolves.toBeNull()
  })
})
