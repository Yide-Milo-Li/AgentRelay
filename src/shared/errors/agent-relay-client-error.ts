/** Client-side failures carry a dictionary key; server failures carry the server's own message. */
export class AgentRelayClientError extends Error {
  constructor(public key: "errSession" | "errConnection" | "errFailed" | "errClipboard", public serverMessage?: string, public status?: number) {
    super(serverMessage ?? key);
  }
}
