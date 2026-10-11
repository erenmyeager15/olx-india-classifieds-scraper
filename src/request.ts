import type { Response } from 'undici';
import { OlxResponseValidationError } from './validation.js';

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class OlxBudgetLimitError extends Error {
  constructor() {
    super('User spending limit reached; no further OLX requests were made.');
    this.name = 'OlxBudgetLimitError';
  }
}

export type RequestErrorCategory = 'request_timeout' | 'network_failure' | 'http_error'
  | 'response_size_limit' | 'invalid_json';

export class OlxRequestError extends Error {
  constructor(public readonly category: RequestErrorCategory, public readonly retryable: boolean,
    public readonly httpStatus?: number) {
    const messages: Record<RequestErrorCategory, string> = {
      request_timeout: 'OLX request timed out.',
      network_failure: 'OLX network connection failed.',
      http_error: retryable ? `OLX returned retryable status ${httpStatus}` : `OLX request failed with HTTP ${httpStatus}.`,
      response_size_limit: 'OLX response exceeded the 8 MiB size limit.',
      invalid_json: 'OLX returned invalid JSON.',
    };
    super(messages[category]);
    this.name = 'OlxRequestError';
  }
}

export function assertRequestBudget(canContinue?: () => boolean): void {
  if (canContinue && !canContinue()) throw new OlxBudgetLimitError();
}

/** Preserve useful, fixed failure categories without logging proxy credentials or response text. */
export function safeRequestError(error: unknown): Error {
  if (error instanceof OlxBudgetLimitError || error instanceof OlxRequestError
    || error instanceof OlxResponseValidationError) return error;
  const candidate = error as { name?: string; message?: string; code?: string; cause?: { code?: string } } | undefined;
  const timeout = /timeout|timed out|abort/i.test(`${candidate?.name ?? ''} ${candidate?.code ?? ''}
    ${candidate?.cause?.code ?? ''} ${candidate?.message ?? ''}`);
  return new OlxRequestError(timeout ? 'request_timeout' : 'network_failure', true);
}

export function errorCategory(error: unknown): string {
  if (error instanceof OlxBudgetLimitError) return 'spending_limit';
  if (error instanceof OlxRequestError || error instanceof OlxResponseValidationError) return error.category;
  return 'unexpected_error';
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new OlxRequestError('response_size_limit', false);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new OlxRequestError('invalid_json', true);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new OlxRequestError('response_size_limit', false);
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
    catch { throw new OlxRequestError('invalid_json', true); }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
