import type { Message } from "grammy/types";

/**
 * True when the message is a bot command at the start of the text (e.g. /new).
 * @internal
 */
export function isBotCommand(msg: Message): boolean {
  return Boolean(msg.entities?.some((e) => e.type === "bot_command" && e.offset === 0));
}
