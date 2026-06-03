import type { Message } from "grammy/types";

/**
 * True when the message is a bot command at the start of the text (e.g. /new).
 * @internal
 */
export function isBotCommand(msg: Message): boolean {
  return Boolean(msg.entities?.some((e) => e.type === "bot_command" && e.offset === 0));
}

/** Command name without the leading slash or @bot suffix, e.g. `q` for `/q`. */
export function botCommandName(msg: Message): string | undefined {
  if (!isBotCommand(msg)) return undefined;
  const command = msg.entities?.find((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (!command || !msg.text) return undefined;
  return msg.text.slice(1, command.length).split("@", 1)[0];
}
