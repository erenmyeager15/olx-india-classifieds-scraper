import { Actor, log } from 'apify';
import { wasPushedRecordSaved } from './billing.js';
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
  let spendingLimitReached = false;
  for await (const record of scrapeOlxListings(input, proxyConfiguration)) {
    const chargingResult = await pushAndCharge(record);
    const recordWasSaved = wasPushedRecordSaved(chargingResult);
    if (recordWasSaved) {
      saved += 1;
    }

    if (chargingResult.eventChargeLimitReached) {
      spendingLimitReached = true;
      await Actor.setStatusMessage(`Stopped at the user's spending limit after ${saved} listings`);
      log.warning('User spending limit reached; stopping before more OLX search or detail requests.');
      break;
    }
  }

  if (saved === 0 && !spendingLimitReached) {
    throw new Error('No OLX listings matched the input. Try a broader keyword, location, or price range.');
  }

  if (saved === 0) {
    log.warning('Stopped before saving OLX listings because the user spending limit was reached.');
  } else {
    log.info(`Finished. Saved ${saved} OLX listing records.`);
  }
} catch (error) {
  log.exception(error instanceof Error ? error : new Error(String(error)), 'OLX scraper failed');
  throw error;
} finally {
  await Actor.exit();
}
