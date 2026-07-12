/**
 * Claude usage runs on the signed-in subscription, not an API key, so hitting a limit is a
 * "wait" condition rather than a failure. The worker backs off and re-enters the stage
 * instead of burning one of the task's retry attempts on it.
 */
export class RateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimited";
  }
}

/** Rate limits surface as prose, not status codes, so we have to sniff for them. */
export function looksRateLimited(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("rate limit") || t.includes("usage limit") || t.includes("429");
}
