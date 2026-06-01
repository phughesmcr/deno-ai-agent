import { type ApprovalGate, DEFAULT_APPROVAL_TIMEOUT_MS, requireApproval } from "./approval.ts";

/** Fetch-compatible function used by NetworkGate. */
export type NetworkGateFetcher = typeof fetch;

/** Dependencies for outbound app-owned network gating. */
export interface NetworkGateOptions {
  /** Approval gate used for non-internal outbound hosts. */
  approvalGate: ApprovalGate;
  /** Returns the active session id for approval requests. */
  sessionId: () => string;
  /** Returns the active turn id for approval requests. */
  turnId: () => string;
  /** Host:port entries that are internal app clients and do not need approval. */
  internalHosts?: string[];
  /** Fetch implementation, injectable for tests. */
  fetcher?: NetworkGateFetcher;
}

/** Approval-wrapped fetch boundary for model/tool-requested outbound requests. */
export class NetworkGate {
  readonly #approvalGate: ApprovalGate;
  readonly #sessionId: () => string;
  readonly #turnId: () => string;
  readonly #internalHosts: Set<string>;
  readonly #fetcher: NetworkGateFetcher;

  /** Creates a network gate. */
  constructor(options: NetworkGateOptions) {
    this.#approvalGate = options.approvalGate;
    this.#sessionId = options.sessionId;
    this.#turnId = options.turnId;
    this.#internalHosts = new Set(options.internalHosts ?? []);
    this.#fetcher = options.fetcher ?? fetch;
  }

  /** Runs fetch after approving non-internal hosts. */
  async fetch(input: string | URL | Request, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    const host = url.host;

    if (!this.#internalHosts.has(host)) {
      await requireApproval(this.#approvalGate, {
        operation: "network",
        target: url.origin,
        summary: `${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}`,
        risk: "high",
        sessionId: this.#sessionId(),
        turnId: this.#turnId(),
        timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      }, signal);
    }

    return await this.#fetcher(input as RequestInfo | URL, init);
  }
}
