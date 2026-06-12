import { Actor, log } from 'apify';
import type { ActorInput } from './types.js';
import { normalizeInput, pushAndCharge, scrapeOlxListings } from './routes.js';

await Actor.init();

try {
  const rawInput = (await Actor.getInput<ActorInput>()) ?? {};
  const input = normalizeInput(rawInput);
  const proxyConfiguration = rawInput.proxyConfiguration
    ? await Actor.createProxyConfiguration(rawInput.proxyConfiguration)
    : undefined;

  log.info('Starting OLX India Classifieds Scraper', {
    keywords: input.keywords,
    locations: input.locations,
    maxResults: input.maxResults,
    includeItemDetails: input.includeItemDetails,
  });

  let saved = 0;
  for await (const record of scrapeOlxListings(input, proxyConfiguration)) {
    await pushAndCharge(record);
    saved += 1;
  }

  if (saved === 0) {
    log.warning('No OLX listings matched the input. Try a broader keyword or location.');
  } else {
    log.info(`Finished. Saved ${saved} OLX listing records.`);
  }
} finally {
  await Actor.exit();
}
