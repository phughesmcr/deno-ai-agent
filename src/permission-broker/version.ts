/** Minimum Deno version supported by the broker-backed Silas runtime. */
export const MIN_BROKER_DENO_VERSION = { major: 2, minor: 8, patch: 1 };

function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Unable to parse Deno version: ${version}`);
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

/** Returns true when the current Deno runtime supports the permission broker. */
export function supportsPermissionBroker(version = Deno.version.deno): boolean {
  const current = parseVersion(version);
  if (current.major !== MIN_BROKER_DENO_VERSION.major) return current.major > MIN_BROKER_DENO_VERSION.major;
  if (current.minor !== MIN_BROKER_DENO_VERSION.minor) return current.minor > MIN_BROKER_DENO_VERSION.minor;
  return current.patch >= MIN_BROKER_DENO_VERSION.patch;
}

/** Throws when the permission broker is unavailable in this Deno build. */
export function assertPermissionBrokerSupported(version = Deno.version.deno): void {
  if (!supportsPermissionBroker(version)) {
    throw new Error(
      `Deno ${version} is below the supported Silas runtime; require >= ${MIN_BROKER_DENO_VERSION.major}.${MIN_BROKER_DENO_VERSION.minor}.${MIN_BROKER_DENO_VERSION.patch}`,
    );
  }
}
