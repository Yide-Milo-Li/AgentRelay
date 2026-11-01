import { AgentRelayClientError } from "@/shared/errors/agent-relay-client-error";

export async function api<T = unknown>(path: string, method = "GET", data?: unknown, options?: { signal?: AbortSignal; acceptStatuses?: readonly number[] }): Promise<T> {
  const response = await fetch(path, { method, cache: "no-store", signal: options?.signal, headers: data ? { "Content-Type": "application/json" } : undefined, body: data ? JSON.stringify(data) : undefined });
  if (response.status === 401 || response.redirected) throw new AgentRelayClientError("errSession");
  let result: T & { error?: string };
  try { result = await response.json() as T & { error?: string }; } catch { throw new AgentRelayClientError("errConnection"); }
  if (!response.ok && !options?.acceptStatuses?.includes(response.status)) throw new AgentRelayClientError("errFailed", result.error, response.status);
  return result;
}
