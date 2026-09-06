# apps/worker-ai-workflows/automatic-thrifting Specification

## Purpose

Durable AI workflows that turn a wardrobe panorama into marketplace search terms, then pick the best scraped listings and notify the user, without coupling those steps to panorama generation.

## Requirements

### Requirement: Generate search terms workflow endpoint

`worker-ai-workflows` MUST host an Upstash Workflow at `POST /generate-search-terms-products-scraping` (workflow key `generate-search-terms-products-scraping`; the key MUST NOT contain `/`). The payload MUST be `{ "wardrobePanoramaId": "<uuid>" }` as stored on the outbox row (forwarded by worker-outbox-events). A missing or empty `wardrobePanoramaId` MUST fail the workflow without inserting `search_terms_scraped_products`. Unsigned requests that are not valid Upstash Workflow/QStash callbacks MUST return `401`.

#### Scenario: Valid payload starts generation

- **GIVEN** a signed request whose body includes a `wardrobePanoramaId` that exists in `wardrobe_panorama`
- **WHEN** `POST /generate-search-terms-products-scraping` is invoked
- **THEN** the workflow runs and, on success, inserts at most 10 `search_terms_scraped_products` rows for that panorama

#### Scenario: Missing panorama id fails without writes

- **GIVEN** a signed request whose payload omits `wardrobePanoramaId` or sets it to an empty string
- **WHEN** the workflow starts
- **THEN** it fails
- **AND** no `search_terms_scraped_products` row is inserted
- **AND** existing thrifting rows for other panoramas are left unchanged

#### Scenario: Unsigned request is rejected

- **GIVEN** a POST to `/generate-search-terms-products-scraping` without a valid QStash/Workflow signature
- **WHEN** the worker handles the request
- **THEN** the response status is `401`

### Requirement: Generate must not delete live products or prior registers

The generate-search-terms workflow MUST NOT delete `scraped_products`, `search_terms_scraped_products`, or `results_search_terms_scraped_products`. If the panorama already has at least one search-term row with `is_processed = false`, it MUST NOT insert additional rows.

#### Scenario: Last week’s products stay visible during term generation

- **GIVEN** panorama `p1` already has `scraped_products` and processed search-term/result rows
- **WHEN** generate-search-terms succeeds for `p1`
- **THEN** those existing `scraped_products` rows still exist
- **AND** new unprocessed `search_terms_scraped_products` rows are inserted for `p1`

#### Scenario: Unprocessed terms block a second generate

- **GIVEN** panorama `p1` already has unprocessed `search_terms_scraped_products` rows
- **WHEN** generate-search-terms runs again for `p1`
- **THEN** no new search-term rows are inserted
- **AND** `scraped_products` is unchanged

### Requirement: Search-term prompt inputs and persistence

The generate-search-terms workflow MUST load the panorama markdown, the owner's routine description (`weekly_outfit_preferences.routine_description` when present), and gender/size preferences (`shopping_suggestions_preferences`). It MUST call the configured LLM and persist a successful call in `llm_interactions`. It MUST insert at most 10 rows into `search_terms_scraped_products` with:

- `wardrobe_panorama_id` set to the payload id
- `llm_interaction_id` set to the audit row
- `marketplace` set to a catalog marketplace `name`
- `json_search` containing at least `term` (non-empty string), `gender` (string or null), and size fields `topSize`, `bottomSize`, `footSize` (each string or null)
- `is_processed` defaulting to `false`
- `created_*` / `updated_*` populated

The workflow MUST NOT set Redis notification keys. Existing `scraped_products` for that panorama MUST remain until analyze swaps them.

#### Scenario: Terms persisted from panorama and preferences

- **GIVEN** panorama `p1` for a user with routine text and gender `Female`, top size `M`
- **AND** the LLM returns 8 valid search terms
- **WHEN** the workflow completes successfully
- **THEN** 8 new unprocessed rows exist in `search_terms_scraped_products` for `p1`
- **AND** each new `json_search.term` is non-empty
- **AND** `llm_interaction_id` is non-null
- **AND** any pre-existing `scraped_products` for `p1` still exist

#### Scenario: Missing shopping preferences still generate terms

- **GIVEN** panorama `p1` whose owner has no `shopping_suggestions_preferences` row
- **WHEN** the workflow completes successfully with LLM terms
- **THEN** rows are inserted with `json_search.gender` and size fields null
- **AND** `json_search.term` is still present

### Requirement: Marketplace catalog and language matching

The workflow MUST read `marketplaces_catalog_scraped_products` and the panorama owner's locale (`app_preferences` / domains; default `pt-BR`). A marketplace is eligible when `supported_languages` is non-empty. Search terms MUST be written in the owner's locale when that locale is listed in `supported_languages`; otherwise they MUST be written in a language from `supported_languages`. Terms MUST be distributed across eligible marketplaces (round-robin when more than one). If no marketplace is eligible, the workflow MUST complete without inserting search-term rows and MUST NOT delete existing products or related registers. At first launch the catalog contains only Enjoei with `pt-BR`.

#### Scenario: pt-BR user receives Enjoei terms

- **GIVEN** locale `pt-BR` and catalog row `{ "name": "enjoei", "supported_languages": ["pt-BR"] }`
- **WHEN** generate-search-terms succeeds
- **THEN** every inserted row has `marketplace` equal to `enjoei`
- **AND** `json_search.term` is in Portuguese

#### Scenario: User locale is used when the marketplace supports it

- **GIVEN** the owner's locale is listed in the marketplace `supported_languages`
- **WHEN** generate-search-terms succeeds
- **THEN** `json_search.term` is written in the owner's locale

#### Scenario: Marketplace language is used when the user locale is not supported

- **GIVEN** the owner's locale is not listed in the marketplace `supported_languages`
- **AND** the marketplace lists another language
- **WHEN** generate-search-terms succeeds
- **THEN** `json_search.term` is written in a marketplace-supported language
- **AND** search-term rows are still inserted
- **AND** existing `scraped_products` are unchanged

#### Scenario: Empty catalog leaves last week’s products

- **GIVEN** an empty `marketplaces_catalog_scraped_products`
- **AND** panorama `p1` has existing `scraped_products`
- **WHEN** generate-search-terms runs for `p1`
- **THEN** `p1`’s `scraped_products` and related search/result rows are unchanged
- **AND** no new search-term rows are inserted
- **AND** the workflow does not fail the outbox dispatch

#### Scenario: Terms are capped at ten across marketplaces

- **GIVEN** two eligible marketplaces and an LLM that could propose more than 10 terms
- **WHEN** the workflow persists results
- **THEN** the total number of inserted rows for that run is at most 10
- **AND** both marketplaces appear among the rows when the LLM produced enough terms

### Requirement: Analyze scraped results workflow endpoint

`worker-ai-workflows` MUST host an Upstash Workflow at `POST /analyze-scraped-products-results` (workflow key `analyze-scraped-products-results`). The payload MUST be `{ "wardrobePanoramaId": "<uuid>" }` as stored on the outbox row. A missing or empty id MUST fail the workflow without writing or deleting `scraped_products`. Unsigned requests MUST return `401`.

#### Scenario: Analyze starts for a panorama with unprocessed results

- **GIVEN** a signed request with an existing `wardrobePanoramaId`
- **AND** that panorama has unprocessed `results_search_terms_scraped_products` rows
- **WHEN** `POST /analyze-scraped-products-results` is invoked
- **THEN** the workflow runs the analysis prompt and persists chosen listings

#### Scenario: Unsigned analyze request is rejected

- **GIVEN** a POST to `/analyze-scraped-products-results` without a valid QStash/Workflow signature
- **WHEN** the worker handles the request
- **THEN** the response status is `401`

### Requirement: Atomic swap only when new scraped_products are ready

The analyze workflow MUST load panorama markdown, routine description when present, and unprocessed scrape results for that panorama (`results_search_terms_scraped_products` joined to `search_terms_scraped_products`). When unprocessed results exist, it MUST call the LLM to choose at most one listing per search term and MUST persist the LLM call in `llm_interactions`. Search terms with no usable listing MAY be omitted from the new product set.

The analyze workflow MUST NOT delete `search_terms_scraped_products` or `results_search_terms_scraped_products` except inside the product swap. Only when at least one new `scraped_products` row is ready to insert, the workflow MUST, in a single transaction for that `wardrobe_panorama_id`: delete existing `scraped_products`; insert the chosen listings (same product-type domain as today's clothing-item scraped products), each with `result_search_term_scraped_product_id` set to the `results_search_terms_scraped_products.id` it was chosen from; delete leftover `results_search_terms_scraped_products` and `search_terms_scraped_products` from prior pipeline runs for that panorama (search-term ids not among this run's unprocessed results). It MUST keep the newly inserted `scraped_products`. It MUST keep this run's `search_terms_scraped_products` and `results_search_terms_scraped_products` rows and MUST mark those kept result rows `is_processed = true`. It MUST NOT delete search/result registers before the new product rows are inserted, and MUST NOT delete them when no new products are inserted. Each inserted listed row MUST reference a distinct result id (the column is unique). The workflow MUST NOT insert a listed row without that foreign key.

If there are no unprocessed results, or the LLM yields zero listings to insert, the workflow MUST NOT call a delete, MUST NOT insert `scraped_products`, MUST NOT set a notification, and last week’s `scraped_products` and related registers MUST remain.

#### Scenario: Swap replaces last week when new products are ready

- **GIVEN** panorama `p1` has last week’s `scraped_products` plus this week’s unprocessed result rows for two search terms
- **AND** leftover search-term/result rows from a prior run
- **WHEN** analyze chooses one listing per term and completes successfully
- **THEN** `scraped_products` for `p1` contains only the newly chosen listings
- **AND** last week’s `scraped_products` for `p1` are gone
- **AND** each new listed row stores that listing’s `results_search_terms_scraped_products.id` in `result_search_term_scraped_product_id`
- **AND** no two listed rows store the same result id
- **AND** this run’s `search_terms_scraped_products` and `results_search_terms_scraped_products` rows for `p1` still exist
- **AND** leftover search-term/result rows from the prior run for `p1` are gone

#### Scenario: Empty or failed selection keeps last week

- **GIVEN** panorama `p1` has last week’s `scraped_products`
- **AND** there are no unprocessed results (or the LLM chooses zero listings)
- **WHEN** analyze runs
- **THEN** last week’s `scraped_products` for `p1` still exist
- **AND** related search-term and result rows for `p1` still exist
- **AND** no unread automatic-thrifting notification key is set
- **AND** no DELETE is issued against `search_terms_scraped_products` or `results_search_terms_scraped_products`

### Requirement: Redis cache and notification after successful analysis

After a successful swap that inserted at least one `scraped_products` row, the analyze workflow MUST delete the web list cache key `shopping-suggestions:{userId}` and MUST SET `notification:new-shopping-suggestions:{userId}` to `{"updatedAt":"<ISO-8601>"}`. These keys MUST match the SkyDIIV web app. Redis failures MUST NOT roll back the database writes. The generate-search-terms workflow and the panorama workflow MUST NOT set these keys.

#### Scenario: User is notified after chosen products are saved

- **GIVEN** analysis swapped in one or more `scraped_products` for the panorama owner `u1`
- **WHEN** the workflow finishes the cache step
- **THEN** `shopping-suggestions:u1` is deleted
- **AND** `notification:new-shopping-suggestions:u1` holds an `updatedAt` timestamp

#### Scenario: Redis outage still persists the swap

- **GIVEN** analysis successfully swapped `scraped_products`
- **AND** web Redis is unavailable
- **WHEN** the cache step runs
- **THEN** the database rows from the swap remain
- **AND** the workflow logs a warning rather than failing the swap

### Requirement: Panorama no longer enqueues marketplace scrapes

`POST /generate-wardrobe-panorama` MUST persist markdown panorama content without requiring a trailing shopping-suggestions JSON fence. It MUST NOT insert `outbox_events` for `scrape-shopping-suggestions`. Editorial markdown about what to look for MAY remain in the panorama text.

#### Scenario: Panorama succeeds without scrape outbox

- **GIVEN** a signed panorama workflow run that produces markdown without a trailing JSON array
- **WHEN** the workflow completes
- **THEN** `wardrobe_panorama.content` is saved
- **AND** no new `scrape-shopping-suggestions` outbox row is inserted

#### Scenario: Trailing JSON is not required

- **GIVEN** the LLM returns only markdown sections including “what to look for”
- **WHEN** execute-prompt parses the response
- **THEN** the workflow does not fail for a missing JSON fence
