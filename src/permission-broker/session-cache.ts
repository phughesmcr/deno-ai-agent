/** Cache grant scope for an allowed permission. */
export type SessionGrantScope = "once" | "session";

/**
 * In-memory grants keyed by permission + normalized value.
 * @internal
 */
export class SessionCache {
  private readonly _session = new Set<string>();
  private readonly _once = new Set<string>();

  private key(permission: string, value: string | null): string {
    return `${permission}\0${value ?? ""}`;
  }

  /** Returns true for a matching grant, consuming one-time grants atomically. */
  consume(permission: string, value: string | null): boolean {
    const key = this.key(permission, value);
    if (this._session.has(key)) return true;
    if (!this._once.has(key)) return false;
    this._once.delete(key);
    return true;
  }

  /** Records a grant; `once` entries are consumed on the next successful check. */
  grant(permission: string, value: string | null, scope: SessionGrantScope): void {
    const key = this.key(permission, value);
    if (scope === "session") {
      this._session.add(key);
      this._once.delete(key);
      return;
    }
    this._once.add(key);
  }
}
