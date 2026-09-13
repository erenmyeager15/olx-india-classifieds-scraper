import { Actor, log } from 'apify';
import { wasPushedRecordSaved } from './billing.js';
import type { ActorInput } from './types.js';
import { normalizeInput, pushAndCharge, scrapeOlxListings } from './routes.js';

await Actor.init();

try {
  const rawInput = (await Actor.getInput<ActorInput>()) ?? {};
  const input = normalizeInput(rawInput);
  const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);

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

  if (saved === 0) {
    if (spendingLimitReached) {
      log.warning('Stopped before saving OLX listings because the user spending limit was reached.');
    } else {
      await Actor.setStatusMessage('Finished successfully. No OLX listings matched the supplied filters.');
      log.info('Finished successfully with no matching OLX listings.');
    }
  } else {
    log.info(`Finished. Saved ${saved} OLX listing records.`);
  }
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  log.exception(failure, 'OLX scraper failed');
  await Actor.fail(failure.message);
}

await Actor.exit();
