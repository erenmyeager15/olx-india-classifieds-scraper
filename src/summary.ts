import type { NormalizedInput } from './types.js';

export interface ScanProgress {
  requestedLocations: number;
  resolvedLocations: number;
  skippedLocations: number;
  approximateLocations: number;
  requestedSearchJobs: number;
  resolvedSearchJobs: number;
  startedSearchJobs: number;
  exhaustedSearchJobs: number;
  failedSearchJobs: number;
  pageLimitedJobs: number;
  noMatchLimitedJobs: number;
  successfulSearchPages: number;
  failedSearchPages: number;
  detailRequests: number;
  failedDetailRequests: number;
  yieldedListings: number;
  resultLimitReached: boolean;
}

export type RunOutcome = 'complete' | 'empty' | 'partial' | 'limited' | 'failed';

export function createScanProgress(input?: NormalizedInput): ScanProgress {
  return {
    requestedLocations: input?.locations.length ?? 0,
    resolvedLocations: 0,
    skippedLocations: 0,
    approximateLocations: 0,
    requestedSearchJobs: (input?.locations.length ?? 0) * (input?.keywords.length ?? 0),
    resolvedSearchJobs: 0,
    startedSearchJobs: 0,
    exhaustedSearchJobs: 0,
    failedSearchJobs: 0,
    pageLimitedJobs: 0,
    noMatchLimitedJobs: 0,
    successfulSearchPages: 0,
    failedSearchPages: 0,
    detailRequests: 0,
    failedDetailRequests: 0,
    yieldedListings: 0,
    resultLimitReached: false,
  };
}

export function buildRunSummary(
  progress: ScanProgress,
  savedListings: number,
  spendingLimitReached = false,
  runFailed = false,
) {
  const limitationReasons: string[] = [];
  if (progress.resultLimitReached) limitationReasons.push('max_results');
  if (spendingLimitReached) limitationReasons.push('spending_limit');
  if (progress.pageLimitedJobs > 0) limitationReasons.push('page_cap');
  if (progress.noMatchLimitedJobs > 0) limitationReasons.push('consecutive_no_match_cap');
  const coverageWarnings: string[] = [];
  if (progress.skippedLocations > 0) coverageWarnings.push('unresolved_locations');
  if (progress.approximateLocations > 0) coverageWarnings.push('approximate_location_matches');
  if (progress.failedSearchPages > 0) coverageWarnings.push('search_request_failures');
  if (progress.failedDetailRequests > 0) coverageWarnings.push('requested_detail_unavailable');

  const allRequestedJobsExhausted = progress.requestedSearchJobs > 0
    && progress.exhaustedSearchJobs === progress.requestedSearchJobs;
  let outcome: RunOutcome;
  if (runFailed || (progress.successfulSearchPages === 0 && coverageWarnings.length > 0)) {
    outcome = 'failed';
  } else if (coverageWarnings.length > 0) {
    outcome = 'partial';
  } else if (limitationReasons.length > 0) {
    outcome = 'limited';
  } else if (allRequestedJobsExhausted) {
    outcome = savedListings > 0 ? 'complete' : 'empty';
  } else {
    outcome = 'partial';
    coverageWarnings.push('search_coverage_not_exhausted');
  }

  return {
    schemaVersion: 1,
    source: 'olx',
    outcome,
    searchCoverageComplete: allRequestedJobsExhausted && progress.skippedLocations === 0
      && progress.approximateLocations === 0 && progress.failedSearchPages === 0
      && limitationReasons.length === 0 && !runFailed,
    detailCoverageComplete: progress.failedDetailRequests === 0 && !runFailed,
    savedListings,
    yieldedListings: progress.yieldedListings,
    requestedLocations: progress.requestedLocations,
    resolvedLocations: progress.resolvedLocations,
    skippedLocations: progress.skippedLocations,
    approximateLocations: progress.approximateLocations,
    requestedSearchJobs: progress.requestedSearchJobs,
    resolvedSearchJobs: progress.resolvedSearchJobs,
    startedSearchJobs: progress.startedSearchJobs,
    unstartedSearchJobs: Math.max(0, progress.requestedSearchJobs - progress.startedSearchJobs),
    exhaustedSearchJobs: progress.exhaustedSearchJobs,
    failedSearchJobs: progress.failedSearchJobs,
    unfinishedSearchJobs: Math.max(0, progress.requestedSearchJobs - progress.exhaustedSearchJobs
      - progress.failedSearchJobs - progress.pageLimitedJobs - progress.noMatchLimitedJobs),
    pageLimitedJobs: progress.pageLimitedJobs,
    noMatchLimitedJobs: progress.noMatchLimitedJobs,
    successfulSearchPages: progress.successfulSearchPages,
    failedSearchPages: progress.failedSearchPages,
    detailRequests: progress.detailRequests,
    failedDetailRequests: progress.failedDetailRequests,
    limitationReasons,
    coverageWarnings,
    finishedAt: new Date().toISOString(),
  };
}

export function runStatusMessage(summary: ReturnType<typeof buildRunSummary>): string {
  const count = summary.savedListings;
  switch (summary.outcome) {
    case 'empty': return 'Finished. No matching listings in the fully checked requested searches.';
    case 'complete': return `Finished. Saved ${count} listings; requested searches exhausted.`;
    case 'partial': return `Partial coverage. Saved ${count} listings; check OLX-RUN-SUMMARY for source gaps.`;
    case 'limited': return `Stopped at a configured limit after ${count} listings; search coverage may be incomplete.`;
    case 'failed': return `Failed after ${count} saved listings; check OLX-RUN-SUMMARY.`;
  }
}
