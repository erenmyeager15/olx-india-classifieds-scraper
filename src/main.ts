import { Actor, log } from 'apify';
import { wasPushedRecordSaved } from './billing.js';
import type { ActorInput } from './types.js';
import { normalizeInput, pushAndCharge, scrapeOlxListings } from './routes.js';
import { buildRunSummary, createScanProgress, runStatusMessage } from './summary.js';

await Actor.init();

let progress = createScanProgress();
let saved = 0;
let spendingLimitReached = false;
let failure: Error | undefined;
try {
  const rawInput = (await Actor.getInput<ActorInput>()) ?? {};
  const input = normalizeInput(rawInput);
  progress = createScanProgress(input);
  const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);

  log.info('Starting OLX India Classifieds Scraper', {
    keywords: input.keywords,
    locations: input.locations,
    maxResults: input.maxResults,
    includeItemDetails: input.includeItemDetails,
  });

  for await (const record of scrapeOlxListings(input, proxyConfiguration, progress)) {
    const chargingResult = await pushAndCharge(record);
    const recordWasSaved = wasPushedRecordSaved(chargingResult);
    if (recordWasSaved) {
      saved += 1;
    }

    if (chargingResult.eventChargeLimitReached) {
      spendingLimitReached = true;
      log.warning('User spending limit reached; stopping before more OLX search or detail requests.');
      break;
    }
  }

} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  log.exception(failure, 'OLX scraper failed');
}

const summary = buildRunSummary(progress, saved, spendingLimitReached, Boolean(failure));
try {
  await Actor.setValue('OLX-RUN-SUMMARY', summary);
  await Actor.setStatusMessage(runStatusMessage(summary));
  log.info('OLX run coverage summary', summary);
} catch (error) {
  failure ??= new Error('Could not save the OLX run coverage summary.');
  log.exception(error instanceof Error ? error : new Error(String(error)), 'OLX summary persistence failed');
}
if (failure) await Actor.fail(failure.message);
await Actor.exit();
