# OLX India Classifieds Scraper - Prices, Sellers & Locations

Scrape OLX India classifieds listings and export clean listing data to JSON, CSV, Excel, or HTML, or pull it via the Apify API. This actor searches OLX India by keyword and location, extracts real listing records from OLX public JSON endpoints, and saves prices, seller metadata, locations, images, posting dates, and listing URLs. No login or API key is required.

## What It Extracts

- Listing ID and title
- Search keyword and requested location
- Category ID and category name when available
- Price, display price, and currency
- Seller name, seller type, business seller flag, elite seller flag, and KYC flag when available
- Redacted listing description
- Status, state, city, area, latitude, and longitude
- Posted date, created date, and valid-to date
- Main image URL, image count, video count, and favorite count
- OLX listing URL
- Non-sensitive listing parameters such as brand, model, year, fuel type, or size when available
- Scraped timestamp

## Use Cases

- Classifieds price monitoring for phones, cars, bikes, furniture, and electronics
- Local resale market research across Indian cities and states
- Dealer and business-seller discovery without manual OLX searches
- Inventory tracking for second-hand marketplaces and recommerce teams
- Trend analysis for used-product demand, price ranges, and listing volume

## Pricing

| Event | Price | 1,000 listings | 10,000 listings |
| --- | ---: | ---: | ---: |
| `listing-scraped` | `$0.002` per listing | `$2.00` | `$20.00` |

You are charged only after a clean listing record is saved to the dataset.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `keywords` | string array | Search terms such as `iphone`, `sofa`, `swift`, or `laptop`. |
| `locations` | string array | City, state, neighborhood, or `India`. Examples: `Mumbai`, `Delhi`, `Bengaluru`, `Maharashtra`. |
| `categoryId` | string | Optional OLX category ID. Leave empty to search all categories. |
| `minPrice` | integer | Optional minimum price in INR. |
| `maxPrice` | integer | Optional maximum price in INR. |
| `maxResults` | integer | Number of unique listings to save, up to 500. |
| `includeItemDetails` | boolean | Fetch each item detail endpoint for richer fields. |
| `includeDescription` | boolean | Include descriptions with contact-like strings redacted. |
| `proxyConfiguration` | object | Optional Apify Proxy settings. |

## How to Scrape OLX India Classifieds (Step by Step)

1. Enter one or more keywords, such as `iphone`, `bike`, or `flat`.
2. Add one or more locations, such as `Mumbai`, `Delhi`, or `India`.
3. Optionally set a category ID, price range, and max result count.
4. Run the actor and wait for the dataset to fill with OLX listings.
5. Export the results as JSON, CSV, Excel, or connect through the Apify API.

## Sample Output

```json
{
  "source": "olx",
  "searchQuery": "iphone",
  "locationQuery": "Mumbai",
  "listingId": "1845529776",
  "title": "iPhone 11 128GB With Free Gifts, Bill & Warranty",
  "categoryId": "1453",
  "category": "Mobile Phones",
  "price": 18999,
  "priceDisplay": "₹ 18,999",
  "currency": "INR",
  "sellerName": "Mega CellBuddy",
  "sellerType": "Regular",
  "isBusiness": true,
  "eliteSeller": false,
  "isKycVerified": false,
  "hasPhoneParam": true,
  "description": "iPhone 11 128GB. All colours available. Contact: [phone redacted].",
  "status": "Active",
  "state": "Maharashtra",
  "city": "Mumbai",
  "area": "Naya Nagar",
  "location": "Naya Nagar, Mumbai, Maharashtra",
  "latitude": 19.18,
  "longitude": 72.84,
  "postedAt": "2026-06-05T17:34:22+05:30",
  "createdAt": "2026-06-05T17:33:19+05:30",
  "validTo": "2026-07-05T17:33:19+05:30",
  "imageUrl": "https://apollo.olx.in/v1/files/example-IN/image;s=505x673",
  "imageCount": 6,
  "videoCount": 0,
  "favoriteCount": 12,
  "listingUrl": "https://www.olx.in/item/iphone-11-128gb-with-free-gifts-bill-and-warranty-iid-1845529776",
  "parameters": {
    "brand": "iPhone"
  },
  "scrapedAt": "2026-06-12T12:15:00.000Z"
}
```

## How It Works

The actor resolves each requested OLX location through OLX India's public location autocomplete endpoint, searches the public OLX relevance API, deduplicates listings by ID, optionally fetches the item detail endpoint, normalizes fields, redacts contact-like strings, and writes records to the Apify dataset.

## Known Limits

- Phone numbers and email addresses are intentionally not exposed. `hasPhoneParam` tells you whether OLX indicates contact data exists.
- OLX category names are returned when the search metadata exposes them. Otherwise `category` can be null while `categoryId` remains available.
- Price filters are applied after records are fetched from OLX, so very narrow ranges may require a broader `maxResults` setting.
- OLX may change or restrict its public endpoints. Use Apify Proxy for larger runs if direct requests become less reliable.
- This actor is not affiliated with OLX.

## License

Apache-2.0
