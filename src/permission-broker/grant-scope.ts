import type { BrokerGrantScope } from "./grant-net.ts";

const scopes: BrokerGrantScope[] = [];

/** Returns the default scope for broker grants in the current async call path. */
export function currentBrokerGrantScope(): BrokerGrantScope {
  return scopes.at(-1) ?? "session";
}

/** Runs an operation with a temporary default broker grant scope. */
export async function withBrokerGrantScope<T>(
  scope: BrokerGrantScope,
  operation: () => T | Promise<T>,
): Promise<T> {
  scopes.push(scope);
  try {
    return await operation();
  } finally {
    scopes.pop();
  }
}
