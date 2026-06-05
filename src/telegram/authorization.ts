interface TelegramAuthorizationContext {
  from?: { id?: number; is_bot?: boolean };
}

/** True for Telegram updates that should not receive an unauthorized-user reply. */
export function shouldIgnoreUnauthorizedMessage(ctx: TelegramAuthorizationContext): boolean {
  if (ctx.from?.is_bot) return true;
  if (!ctx.from) return true;
  return false;
}
