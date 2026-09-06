# apps/robot-scrape-products/automatic-thrifting Specification

## Purpose

Weekly OCI batch robot (`robot-scrape-products`) that scrapes unprocessed automatic-thrifting search terms from Postgres, stores marketplace listings, and enqueues analysis per wardrobe panorama through the transactional outbox.

## Requirements

### Requirement: Drain unprocessed search terms grouped by panorama

When the robot process starts (GitHub Actions weekly create on Friday), it MUST load `search_terms_scraped_products` rows with `is_processed = false`, grouped by `wardrobe_panorama_id`. For each term it MUST scrape the row's `marketplace` using `json_search` (term, gender, sizes) and persist at most 10 listings in `results_search_terms_scraped_products`. After attempting the scrape for a term (success with zero or more listings, or a recorded empty result), it MUST set that search-term row `is_processed = true`. The robot MUST NOT write or delete `scraped_products` and MUST NOT delete prior search-term or result rows. The robot MUST NOT set web Redis notification keys.

#### Scenario: Unprocessed terms become result rows

- **GIVEN** panorama `p1` has two unprocessed search-term rows for `enjoei`
- **AND** the Enjoei scraper returns 7 listings for the first term and 3 for the second
- **WHEN** the robot processes `p1`
- **THEN** `results_search_terms_scraped_products` contains 7 rows for the first term and 3 for the second
- **AND** both search-term rows have `is_processed = true`
- **AND** `scraped_products` is unchanged by the robot
- **AND** last week’s processed search-term rows for `p1`, if any, are still present

#### Scenario: At most ten listings per search term

- **GIVEN** a scraper that would return more than 10 listings for one term
- **WHEN** the robot persists results
- **THEN** at most 10 `results_search_terms_scraped_products` rows exist for that `search_term_scraped_product_id`

#### Scenario: Empty scrape still marks the term processed

- **GIVEN** a search term whose scrape returns zero listings
- **WHEN** the robot finishes that term
- **THEN** that search-term row has `is_processed = true`
- **AND** zero result rows are required for that term

#### Scenario: Already processed terms are skipped

- **GIVEN** only search-term rows with `is_processed = true`
- **WHEN** the robot starts
- **THEN** it performs no marketplace navigation for those rows

### Requirement: Result JSON shape

Each `results_search_terms_scraped_products` row MUST store `search_term_scraped_product_id`, `is_processed` default `false`, `created_*` / `updated_*`, and `json_result` with at least:

- `marketplace` (string)
- `title` (string)
- `price` (number)
- `currency` (string)
- `url` (string)
- `image_url` (string)
- `metadata` (object; extra marketplace fields, including `size`)

Missing image URLs MUST use the existing scraped-product placeholder `https://assets.skydiiv.space/placeholder--scraped-product.png`. Missing currency MUST default to `BRL` for Enjoei. `metadata.size` MUST carry the size published by the marketplace for that listing, or `null` when the search requested no size.

#### Scenario: Successful listing is persisted with core fields

- **GIVEN** a scraped Enjoei listing with title, price, URL, and image
- **WHEN** the robot writes the result row
- **THEN** `json_result` includes `marketplace`, `title`, `price`, `currency`, `url`, `image_url`, and a `metadata` object
- **AND** `metadata.size` holds the listing's size
- **AND** `is_processed` is `false`

### Requirement: Enqueue analyze via outbox per panorama after its batch

After the robot has finished every unprocessed search term for a given `wardrobe_panorama_id` (including terms that yielded zero listings), it MUST insert one PENDING `outbox_events` row for event `analyze-scraped-products-results` with payload `{ "wardrobePanoramaId": "<id>" }` and publish `{ "outboxEventId": "<uuid>" }` to `{WORKER_OUTBOX_EVENTS_URL}/process-outbox-event`. It MUST enqueue at most one such outbox row per panorama per process run. It MUST NOT QStash-publish directly to `worker-ai-workflows`. If QStash publish to worker-outbox-events fails, the outbox row MUST stay `PENDING` and search-term `is_processed` flags already written MUST stay true. The robot MUST NOT consume Cloudflare Queues for `scrape-shopping-suggestions`.

#### Scenario: Analyze is triggered once per panorama through the outbox

- **GIVEN** panoramas `p1` and `p2` each have unprocessed search terms
- **WHEN** the robot finishes both groups
- **THEN** two PENDING (or subsequently processed) `outbox_events` rows exist for `analyze-scraped-products-results`
- **AND** the payloads are `{ "wardrobePanoramaId": "p1" }` and `{ "wardrobePanoramaId": "p2" }`
- **AND** worker-outbox-events received a process-outbox-event publish for each id

#### Scenario: Panorama with no unprocessed terms does not enqueue

- **GIVEN** panorama `p3` has only processed search terms
- **WHEN** the robot runs
- **THEN** no `analyze-scraped-products-results` outbox row is inserted for `p3`

#### Scenario: Robot does not drain CF Queues

- **GIVEN** messages exist on the scrape-shopping-suggestions Cloudflare Queue
- **WHEN** the robot runs the automatic-thrifting batch
- **THEN** those queue messages are not pulled or acknowledged by this process

### Requirement: Marketplace scraper selection from the row

The robot MUST resolve the scraper from `search_terms_scraped_products.marketplace` (case-insensitive). Unknown marketplace names MUST mark the search term processed without inserting result rows and MUST continue with remaining terms. Enjoei search URLs MUST keep using term, gender, and size filters from `json_search`, sending the gender as Enjoei's `department` param (`d`) — `dep` is Enjoei's `recommendation_department` and does not filter the feed.

#### Scenario: Unknown marketplace does not abort the panorama

- **GIVEN** one unprocessed term with `marketplace` `unknown-shop` and another with `enjoei`
- **WHEN** the robot processes the panorama
- **THEN** the unknown term is marked `is_processed = true` with no result rows
- **AND** the Enjoei term is still scraped
- **AND** an analyze outbox row is still inserted for that panorama after both terms are processed

### Requirement: Persisted listings match the requested size

When a search term's `json_search` requests any size (`topSize`, `bottomSize`, or `footSize`), every persisted listing MUST have a size published by the marketplace that matches one of the requested sizes. The marketplace's own search filters MUST NOT be the only check: the robot MUST read the size from the listing's own page and compare it to the request. Sizes MUST be compared case-insensitively and without accents (`Único` matches `unico`). A listing whose size cannot be read MUST be discarded rather than persisted. Search terms that request no size MUST NOT open listing pages.

#### Scenario: Wrong-size listings are not persisted

- **GIVEN** a search term requesting `topSize` `M`
- **AND** the results page lists items whose listing pages publish sizes `M`, `GG`, and `M`
- **WHEN** the robot processes that term
- **THEN** only the two `M` listings become result rows

#### Scenario: The listing page overrides the results-page size

- **GIVEN** a results-page card showing size `M` whose listing page publishes `GG`
- **WHEN** the robot processes a term requesting `M`
- **THEN** that listing is discarded

#### Scenario: Ten listings are still filled from later results

- **GIVEN** a search term requesting `topSize` `M`
- **AND** the first eight results are other sizes, followed by ten `M` results
- **WHEN** the robot processes that term
- **THEN** ten result rows exist, all of size `M`

#### Scenario: Sizeless terms skip listing pages

- **GIVEN** a search term whose `json_search` requests no size
- **WHEN** the robot processes that term
- **THEN** it performs no listing-page navigation
- **AND** up to 10 listings are persisted from the results page
