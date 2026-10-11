import { Actor, log } from 'apify';
import { wasPushedRecordSaved } from './billing.js';
import type { ActorInput } from './types.js';
import { normalizeInput, pushAndCharge, scrapeOlxListings } from './routes.js';
import { buildRunSummary, createScanProgress, runStatusMessage } from './summary.js';
import { createProxyTiers, needsResidentialFallback, residentialFallbackConfig, type ProxyTier } from './proxy.js';
import { assertRequestBudget, errorCategory, OlxBudgetLimitError } from './request.js';

await Actor.init();

let progress = createScanProgress();
let saved = 0;
let spendingLimitReached = false;
let failure: Error | undefined;
let failureDiagnostic: { stage: string; category: string } | undefined;
let stage = 'input';
try {
  const rawInput = (await Actor.getInput<ActorInput>()) ?? {};
  const input = normalizeInput(rawInput);
  progress = createScanProgress(input);
  const canContinue = () => Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit('listing-scraped') > 0;
  // Check before creating a paid proxy or advancing the source generator.
  assertRequestBudget(canContinue);
  stage = 'proxy';
  const proxyConfiguration = await buildProxyTiers(input.proxyConfiguration);

  log.info('Starting OLX India Classifieds Scraper', {
    keywordCount: input.keywords.length,
    locationCount: input.locations.length,
    maxResults: input.maxResults,
    includeItemDetails: input.includeItemDetails,
  });

  stage = 'source';
  for await (const record of scrapeOlxListings(input, proxyConfiguration, progress, { canContinue })) {
    assertRequestBudget(canContinue);
    stage = 'dataset_write';
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
    stage = 'source';
  }

} catch (error) {
  if (error instanceof OlxBudgetLimitError) {
    spendingLimitReached = true;
    log.warning(error.message);
  } else {
    failureDiagnostic = { stage, category: errorCategory(error) };
    failure = new Error(`OLX failed during ${stage} (${failureDiagnostic.category}); check OLX-RUN-SUMMARY.`);
    log.error(failure.message);
  }
}

const summary = buildRunSummary(progress, saved, spendingLimitReached, Boolean(failure), failureDiagnostic);
try {
  await Actor.setValue('OLX-RUN-SUMMARY', summary);
  await Actor.setStatusMessage(runStatusMessage(summary));
  log.info('OLX run coverage summary', summary);
} catch (error) {
  failure ??= new Error('Could not save the OLX run coverage summary.');
  log.error('OLX summary persistence failed. Saved dataset rows, if any, remain available.');
}
if (failure) await Actor.fail(failure.message);
await Actor.exit();

async function buildProxyTiers(requested: Record<string, unknown>) {
  const tiers: ProxyTier[] = [];
  const fallback = needsResidentialFallback(requested);
  try {
    tiers.push({ name: 'requested proxy', proxy: await Actor.createProxyConfiguration(requested) });
  } catch (error) {
    // An inaccessible proxy group must not fail the run when Residential India can serve it.
    if (!fallback) throw error;
    log.warning('The requested proxy configuration could not be created; using Residential India instead.');
  }
  if (fallback) {
    try {
      const residential = await Actor.createProxyConfiguration(residentialFallbackConfig(requested));
      if (residential) tiers.push({ name: 'Residential proxy', proxy: residential });
    } catch (error) {
      log.warning('Residential proxy fallback is unavailable on this account.');
    }
  }
  if (tiers.length === 0) throw new Error('No usable proxy configuration. Enable Apify Residential proxy or choose another proxy setting.');
  return createProxyTiers(tiers, (from, to) =>
    log.warning(`OLX request failed on the ${from}; switching to the ${to} for the rest of this run.`));
}
