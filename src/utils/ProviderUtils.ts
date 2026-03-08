/**
 * Wraps any fetch call with 429 retry logic.
 * Used by all adapters — handles rate limiting consistently across providers.
 */
export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  providerName: string,
  maxRetries: number = 3,
): Promise<Response> {
  let attempt = 0;

  while (attempt <= maxRetries) {
    const response = await doFetch();

    if (response.status !== 429) {
      return response; // ← success, return response
    }

    // Still 429
    if (attempt === maxRetries) {
      return response; // ← final attempt, return response even if it's 429
    }

    const errJson = (await response.json()) as any;
    const errMsg = errJson?.error?.message ?? "";
    const waitMatch = errMsg.match(/try again in (\d+\.?\d*)s/i);
    const waitSecs = waitMatch ? Math.ceil(parseFloat(waitMatch[1])) + 1 : 16;

    console.log(
      `[${providerName}/429] attempt ${attempt + 1}/${maxRetries} waiting ${waitSecs}s...`,
    );
    await new Promise((r) => setTimeout(r, waitSecs * 1000));

    attempt++;
  }

  return await doFetch(); // final attempt
}
