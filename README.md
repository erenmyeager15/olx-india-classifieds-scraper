# OLX India Classifieds Scraper - Prices, Listings & Locations

The OLX India classifieds scraper extracts public listing data from OLX India by keyword and location. Export to JSON, CSV, Excel, or HTML, or pull via the Apify API. No OLX login or OLX API key is required.

This scraper searches OLX India, reads listings from OLX's public JSON endpoints, and saves prices, seller metadata, categories, locations, images, posting dates, and listing URLs into one clean dataset. Built with Node.js 20, TypeScript, and native fetch, it uses optional Apify Proxy with retries and resilient extraction so runs stay reliable and repeatable.

For a low-cost first run, use the default sample input: `iphone` in `Mumbai`, `1` listing, with item details and descriptions disabled.

## What It Extracts

- Listing ID and title
- Search keyword and requested location
- Category ID and category name when available
- Price, display price, and currency
- Seller type, business seller flag, elite seller flag, and KYC flag when available
- Optional redacted listing description
- Status, state, city, area, latitude, and longitude
- Posted date, created date, and valid-to date when available
- Main image URL, image count, video count, and favorite count
- OLX listing URL
- Non-sensitive listing parameters such as brand, model, year, fuel type, or size when available
- Scraped timestamp

## Use Cases

- Classifieds price monitoring for phones, cars, bikes, furniture, and electronics
- Local resale market research across Indian cities and states
- Dealer and business-listing activity analysis for market research
- Inventory tracking for second-hand marketplaces and recommerce teams
- Trend analysis for used-product demand, price ranges, and listing volume

## Pricing

| Event | Price | Notes |
| --- | ---: | --- |
| `apify-actor-start` | `$0.00005` per GB | Charged when the Actor starts. A 4 GB run charges 4 start events. |
| `listing-scraped` | `$0.002` per listing | Charged once for each clean OLX India listing saved to the dataset. |

Example listing-event cost: 1,000 saved listings cost `$2.00`; 10,000 saved listings cost `$20.00`. Start events are tiny but still included in paid runs.

Each clean listing is saved and charged atomically. The Actor stops before further OLX search or detail requests when the user's maximum run cost is reached.

To control cost, start with one keyword, one location, and `maxResults: 1`. Increase volume only after the sample output looks right. Keep item details and descriptions disabled for the cheapest first run; enable them only when you need richer fields. OLX usually works without a proxy for low-volume checks, so enable Apify Proxy only if direct requests become unreliable or if you are running larger jobs.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `keywords` | string array | `["iphone"]` | Search terms such as `iphone`, `sofa`, `swift`, or `laptop`. Up to 10 items. |
| `locations` | string array | `["Mumbai"]` | City, state, neighborhood, or `India`. Examples: `Mumbai`, `Delhi`, `Bengaluru`, `Maharashtra`. Up to 10 items. |
| `categoryId` | string | empty | Optional OLX category ID. Leave empty to search all categories. |
| `minPrice` | integer | empty | Optional minimum price in INR. |
| `maxPrice` | integer | empty | Optional maximum price in INR. |
| `maxResults` | integer | `1` | Number of unique listings to save, up to 500. |
| `includeItemDetails` | boolean | `false` | Fetch each item detail endpoint for richer fields. Enable only when needed. |
| `includeDescription` | boolean | `false` | Include descriptions with contact-like strings redacted. |
| `proxyConfiguration` | object | direct request | Optional Apify Proxy settings. |

The actor runs at 4 GB memory with a 60-minute timeout. It allows up to 25 keyword/location combinations per run so accidental broad grids do not create expensive or confusing jobs.

## How to Scrape OLX India Classifieds

1. Enter one or more keywords, such as `iphone`, `bike`, or `flat`.
2. Add one or more locations, such as `Mumbai`, `Delhi`, or `India`.
3. Optionally set a category ID, price range, and max result count.
4. Run the Actor and wait for the dataset to fill with OLX listings.
5. Export the results as JSON, CSV, Excel, HTML, or connect through the Apify API.

## Example Input

```json
{
  "keywords": ["iphone"],
  "locations": ["Mumbai"],
  "maxResults": 1,
  "includeItemDetails": false,
  "includeDescription": false,
  "proxyConfiguration": { "useApifyProxy": false }
}
```

### Multi-city, price-filtered search

```json
{
  "keywords": ["swift", "creta"],
  "locations": ["Delhi", "Bengaluru"],
  "minPrice": 200000,
  "maxPrice": 800000,
  "maxResults": 20,
  "includeItemDetails": true,
  "includeDescription": true,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

## Output Dataset

```json
{
  "source": "olx",
  "searchQuery": "iphone",
  "locationQuery": "Mumbai",
  "listingId": "1845620279",
  "title": "Iphone Xs Gold",
  "categoryId": "1453",
  "category": "Mobile Phones",
  "price": 20000,
  "priceDisplay": "INR 20,000",
  "currency": "INR",
  "sellerType": "Regular",
  "isBusiness": false,
  "eliteSeller": false,
  "isKycVerified": false,
  "hasPhoneParam": false,
  "description": "Iphone Xs. Gold colour. 256gb. Battery health 80%. All original.",
  "status": "Active",
  "state": "Maharashtra",
  "city": "Mumbai",
  "area": null,
  "location": "Mumbai, Maharashtra",
  "latitude": 19.059,
  "longitude": 72.86,
  "postedAt": "2026-06-10T19:42:22+05:30",
  "createdAt": "2026-06-10T19:41:01+05:30",
  "validTo": "2026-07-06T15:59:14+05:30",
  "imageUrl": "https://apollo.olx.in/v1/files/example-IN/image;s=505x673",
  "imageCount": 6,
  "videoCount": 0,
  "favoriteCount": 0,
  "listingUrl": "https://www.olx.in/item/iphone-xs-gold-iid-1845620279",
  "parameters": {
    "brand": "iPhone"
  },
  "scrapedAt": "2026-06-12T19:55:50.582Z"
}
```

Descriptions are included only when `includeDescription` is enabled. Phone-like strings and email addresses are redacted, and sensitive contact parameters are not exposed.

## API Example

```bash
curl -X POST "https://api.apify.com/v2/acts/fascinating_lentil~olx-india-classifieds-scraper/runs?token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keywords":["iphone"],"locations":["Mumbai"],"maxResults":1,"includeItemDetails":false,"includeDescription":false}'
```

```js
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });
const run = await client.actor('fascinating_lentil/olx-india-classifieds-scraper').call({
  keywords: ['iphone'],
  locations: ['Mumbai'],
  maxResults: 1,
  includeItemDetails: false,
  includeDescription: false,
});
const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(`Got ${items.length} OLX listings`);
```

## How It Works

The actor resolves each requested OLX location through OLX India's public location autocomplete endpoint, searches the public OLX relevance API, deduplicates listings by ID, optionally fetches item detail endpoints, normalizes fields, redacts contact-like strings, and writes records to the Apify dataset.

If a specific location cannot be resolved, the actor skips it instead of silently searching all of India under the wrong location label. If no requested location can be resolved, the run fails with a clear error.

## Known Limits

- Phone numbers and email addresses are intentionally not exposed. `hasPhoneParam` tells you whether OLX indicates contact data exists.
- OLX category names are returned when the search metadata exposes them. Otherwise `category` can be null while `categoryId` remains available.
- Price filters are applied after records are fetched from OLX, so very narrow ranges may require a broader `maxResults` setting.
- OLX may change or restrict its public endpoints. Use Apify Proxy for larger runs if direct requests become less reliable.
- This actor is not affiliated with OLX.

## Responsible Use

This Actor is intended for lawful collection of publicly available information only. Users are responsible for ensuring their use complies with the source website's terms, robots.txt, applicable privacy laws, including India's DPDP Act, and all local regulations.

Do not use this Actor to collect, store, sell, or misuse personal data without a lawful basis. The Actor author is not responsible for misuse by end users.

## License

Apache-2.0
