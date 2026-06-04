import type {
  UserInteractionPort,
  UserInteractionRequest,
  UserInteractionResult,
} from "../agent/tools/user-question-port.ts";

/** Serializes elicitation handling per MCP connection. */
export class ElicitationGate {
  private _chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._chain.then(fn, fn);
    this._chain = next.then(() => undefined, () => undefined);
    return next;
  }
}

/** Wraps UserInteractionPort so MCP elicitations do not overlap on one connection. */
export function gatedInteractionPort(port: UserInteractionPort, gate: ElicitationGate): UserInteractionPort {
  return {
    isAvailable: () => port.isAvailable(),
    isPending: () => port.isPending(),
    setTurnContext: (t) => port.setTurnContext(t),
    clearTurnContext: () => port.clearTurnContext(),
    notifyUrlElicitationComplete: (id) => port.notifyUrlElicitationComplete?.(id),
    waitForUrlElicitationComplete: (id, signal) =>
      port.waitForUrlElicitationComplete?.(id, signal) ?? Promise.resolve(),
    interact(request: UserInteractionRequest): Promise<UserInteractionResult> {
      if (request.mode === "cursor_questions") return port.interact(request);
      return gate.run(() => port.interact(request));
    },
  };
}
