/** Cache grant scope for an allowed permission. */
export type SessionGrantScope = "once" | "session";

/**
 * In-memory grants keyed by permission + normalized value.
 * @internal
 */
export class SessionCache {
  readonly #session = new Set<string>();
  readonly #once = new Set<string>();

  private key(permission: string, value: string | null): string {
    return `${permission}\0${value ?? ""}`;
  }

  /** Returns true when this request was previously granted. */
  has(permission: string, value: string | null): boolean {
    const key = this.key(permission, value);
    return this.#session.has(key) || this.#once.has(key);
  }

  /** Records a grant; `once` entries are consumed on the next successful check. */
  grant(permission: string, value: string | null, scope: SessionGrantScope): void {
    const key = this.key(permission, value);
    if (scope === "session") {
      this.#session.add(key);
      this.#once.delete(key);
      return;
    }
    this.#once.add(key);
  }

  /** Consumes a one-time grant after it was used to allow a request. */
  consumeOnce(permission: string, value: string | null): void {
    this.#once.delete(this.key(permission, value));
  }
}
