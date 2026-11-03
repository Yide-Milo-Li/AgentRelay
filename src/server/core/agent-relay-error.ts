export class AgentRelayError extends Error {
  /** `retryAfterSeconds` becomes a `Retry-After` header on HTTP responses. */
  constructor(message: string, public status = 400, public retryAfterSeconds?: number) { super(message); }
}
