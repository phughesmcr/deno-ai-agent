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

  /** Returns true for a matching grant, consuming one-time grants atomically. */
  consume(permission: string, value: string | null): boolean {
    const key = this.key(permission, value);
    if (this.#session.has(key)) return true;
    if (!this.#once.has(key)) return false;
    this.#once.delete(key);
    return true;
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
}
