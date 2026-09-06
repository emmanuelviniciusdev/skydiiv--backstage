import { describe, expect, it } from "vitest"
import {
  buildEnjoeiSearchUrl,
  enjoeiProductIdFromUrl,
  mapGenderToEnjoeiDepartment,
  matchesRequestedEnjoeiSize,
  parseSizeList,
  requestedEnjoeiSizeSlugs,
  toEnjoeiBrandSlug,
  toEnjoeiSizeSlug,
} from "../../src/infrastructure/scraping/marketplaces/enjoei-search-url.js"
import { searchParams } from "../helpers/search-params.js"

describe("parseSizeList", () => {
  it("splits comma-separated sizes and trims", () => {
    expect(parseSizeList("M, G")).toEqual(["M", "G"])
    expect(parseSizeList("40")).toEqual(["40"])
    expect(parseSizeList(null)).toEqual([])
    expect(parseSizeList("")).toEqual([])
  })
})

describe("enjoeiProductIdFromUrl", () => {
  it("reads the trailing id, not digits inside the slug", () => {
    expect(
      enjoeiProductIdFromUrl(
        "https://www.enjoei.com.br/p/bermuda-masculina-uvx-jeans-branca-40-149242785",
      ),
    ).toBe("149242785")
  })

  it("ignores a query string and a trailing slash", () => {
    expect(
      enjoeiProductIdFromUrl("https://www.enjoei.com.br/p/jaqueta-143818536?rsid=abc&rsp=1"),
    ).toBe("143818536")
    expect(enjoeiProductIdFromUrl("https://www.enjoei.com.br/p/jaqueta-143818536/")).toBe(
      "143818536",
    )
  })

  it("reads an id with no slug before it", () => {
    expect(enjoeiProductIdFromUrl("https://www.enjoei.com.br/p/-149242785")).toBe("149242785")
  })

  it("returns null when there is no trailing id or no listing path", () => {
    expect(enjoeiProductIdFromUrl("https://www.enjoei.com.br/p/sem-id")).toBeNull()
    expect(enjoeiProductIdFromUrl("https://www.enjoei.com.br/s/?q=blusa")).toBeNull()
    expect(enjoeiProductIdFromUrl("")).toBeNull()
  })
})

describe("toEnjoeiSizeSlug", () => {
  it("lowercases letter sizes and keeps numeric tokens", () => {
    expect(toEnjoeiSizeSlug("M")).toBe("m")
    expect(toEnjoeiSizeSlug("PP")).toBe("pp")
    expect(toEnjoeiSizeSlug("40")).toBe("40")
    expect(toEnjoeiSizeSlug("XGG")).toBe("xgg")
  })

  it("strips accents so accented sizes match Enjoei option slugs", () => {
    expect(toEnjoeiSizeSlug("Único")).toBe("unico")
    expect(toEnjoeiSizeSlug(" único ")).toBe("unico")
  })
})

describe("toEnjoeiBrandSlug", () => {
  it("lowercases and kebab-cases brand names", () => {
    expect(toEnjoeiBrandSlug("Zara")).toBe("zara")
    expect(toEnjoeiBrandSlug("Emporio Armani")).toBe("emporio-armani")
    expect(toEnjoeiBrandSlug("  Youcom  ")).toBe("youcom")
  })
})

describe("mapGenderToEnjoeiDepartment", () => {
  it("maps Female/Male to Enjoei department slugs", () => {
    expect(mapGenderToEnjoeiDepartment("Female")).toBe("feminino")
    expect(mapGenderToEnjoeiDepartment("Male")).toBe("masculino")
    expect(mapGenderToEnjoeiDepartment("feminino")).toBe("feminino")
  })

  it("omits department for null and no-preference", () => {
    expect(mapGenderToEnjoeiDepartment(null)).toBeNull()
    expect(mapGenderToEnjoeiDepartment("No preference")).toBeNull()
    expect(mapGenderToEnjoeiDepartment("Unknown")).toBeNull()
  })
})

describe("requestedEnjoeiSizeSlugs", () => {
  it("collects every requested size across the three size types", () => {
    expect(
      requestedEnjoeiSizeSlugs(
        searchParams("camiseta", { topSize: "M, G", bottomSize: "40", footSize: "38" }),
      ),
    ).toEqual(["m", "g", "40", "38"])
  })

  it("is empty when the search asks for no size", () => {
    expect(requestedEnjoeiSizeSlugs(searchParams("cinto couro"))).toEqual([])
  })

  it("deduplicates sizes shared by two size types", () => {
    expect(
      requestedEnjoeiSizeSlugs(searchParams("macacão", { topSize: "40", bottomSize: "40" })),
    ).toEqual(["40"])
  })
})

describe("matchesRequestedEnjoeiSize", () => {
  it("accepts any listing when no size was requested", () => {
    expect(matchesRequestedEnjoeiSize([], "GG")).toBe(true)
    expect(matchesRequestedEnjoeiSize([], null)).toBe(true)
  })

  it("compares sizes as Enjoei slugs", () => {
    expect(matchesRequestedEnjoeiSize(["m"], "M")).toBe(true)
    expect(matchesRequestedEnjoeiSize(["unico"], "Único")).toBe(true)
    expect(matchesRequestedEnjoeiSize(["m", "g"], "G")).toBe(true)
  })

  it("rejects a different size", () => {
    expect(matchesRequestedEnjoeiSize(["m"], "GG")).toBe(false)
    expect(matchesRequestedEnjoeiSize(["38"], "40")).toBe(false)
  })

  it("rejects a listing whose size is unknown", () => {
    expect(matchesRequestedEnjoeiSize(["m"], null)).toBe(false)
    expect(matchesRequestedEnjoeiSize(["m"], "")).toBe(false)
  })
})

describe("buildEnjoeiSearchUrl", () => {
  it("builds a query-only URL when filters are null", () => {
    expect(buildEnjoeiSearchUrl(searchParams("vestido floral"))).toBe(
      "https://www.enjoei.com.br/s/?q=vestido+floral",
    )
  })

  it("adds department, brand, and size filters from SearchParams", () => {
    const url = buildEnjoeiSearchUrl(
      searchParams("camiseta", {
        gender: "Female",
        topSize: "M, G",
        bottomSize: "40",
        footSize: "38",
        brand: "Emporio Armani",
      }),
    )

    expect(url).toBe(
      "https://www.enjoei.com.br/s/?q=camiseta&d=feminino&b=emporio-armani&sc=m&sc=g&sw=40&ss=38",
    )
  })

  it("uses `d` for the department — `dep` is Enjoei's recommendation_department", () => {
    const url = buildEnjoeiSearchUrl(searchParams("blusa", { gender: "Female" }))

    expect(url).toContain("d=feminino")
    expect(url).not.toContain("dep=")
  })

  it("omits size and brand params when they are null", () => {
    const url = buildEnjoeiSearchUrl(
      searchParams("jaqueta", {
        gender: "Male",
        topSize: null,
        bottomSize: null,
        footSize: null,
        brand: null,
      }),
    )

    expect(url).toBe("https://www.enjoei.com.br/s/?q=jaqueta&d=masculino")
  })
})
