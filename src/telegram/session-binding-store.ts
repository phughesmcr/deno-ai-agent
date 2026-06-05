import { type TelegramConversationRef, telegramThreadKey } from "./conversation.ts";

/** Durable binding from a Telegram conversation ref to a Silas session id. */
export interface TelegramSessionBinding extends TelegramConversationRef {
  /** Saved Silas session id currently bound to this Telegram conversation. */
  sessionId: string;
  /** ISO timestamp for first binding creation. */
  createdAt: string;
  /** ISO timestamp for the last rebind/update. */
  updatedAt: string;
  /** Telegram user id that created the binding, when known. */
  createdBy?: number;
  /** Telegram forum topic name, when the bot created or learned it. */
  topicName?: string;
}

interface BindOptions {
  sessionId: string;
  createdBy?: number;
  topicName?: string;
}

function bindingKey(ref: TelegramConversationRef): Deno.KvKey {
  return ["telegram", "binding", ref.chatId, telegramThreadKey(ref.threadId)];
}

function chatPrefix(chatId: number): Deno.KvKey {
  return ["telegram", "binding", chatId];
}

function createBinding(ref: TelegramConversationRef, options: BindOptions, createdAt?: string): TelegramSessionBinding {
  const now = new Date().toISOString();
  return {
    chatId: ref.chatId,
    ...(ref.threadId !== undefined ? { threadId: ref.threadId } : {}),
    sessionId: options.sessionId,
    createdAt: createdAt ?? now,
    updatedAt: now,
    ...(options.createdBy !== undefined ? { createdBy: options.createdBy } : {}),
    ...(options.topicName !== undefined ? { topicName: options.topicName } : {}),
  };
}

function bindingSortKey(binding: TelegramSessionBinding): string {
  return `${telegramThreadKey(binding.threadId).padStart(16, "0")}:${binding.sessionId}`;
}

/** Deno KV-backed Telegram conversation to session binding store. */
export class TelegramSessionBindingStore {
  private readonly _kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  /** Returns the binding for one Telegram conversation, if known. */
  async get(ref: TelegramConversationRef): Promise<TelegramSessionBinding | undefined> {
    const entry = await this._kv.get<TelegramSessionBinding>(bindingKey(ref));
    return entry.value ?? undefined;
  }

  /** Creates or replaces the binding for one Telegram conversation. */
  async bind(ref: TelegramConversationRef, options: BindOptions): Promise<TelegramSessionBinding> {
    const key = bindingKey(ref);
    while (true) {
      const previous = await this._kv.get<TelegramSessionBinding>(key);
      const binding = createBinding(ref, options, previous.value?.createdAt);
      const result = await this._kv.atomic().check(previous).set(key, binding).commit();
      if (result.ok) return binding;
    }
  }

  /** Atomically creates a binding when absent; returns the existing binding otherwise. */
  async createIfMissing(
    ref: TelegramConversationRef,
    options: BindOptions,
  ): Promise<{ binding: TelegramSessionBinding; created: boolean }> {
    const key = bindingKey(ref);
    const previous = await this._kv.get<TelegramSessionBinding>(key);
    if (previous.value) return { binding: previous.value, created: false };

    const binding = createBinding(ref, options);
    const result = await this._kv.atomic().check(previous).set(key, binding).commit();
    if (result.ok) return { binding, created: true };

    const current = await this.get(ref);
    if (!current) throw new Error("Telegram session binding was not created");
    return { binding: current, created: false };
  }

  /** Lists known bindings for a chat. Telegram does not expose all topics to bots. */
  async listForChat(chatId: number): Promise<TelegramSessionBinding[]> {
    const bindings: TelegramSessionBinding[] = [];
    for await (const entry of this._kv.list<TelegramSessionBinding>({ prefix: chatPrefix(chatId) })) {
      bindings.push(entry.value);
    }
    return bindings.toSorted((a, b) => bindingSortKey(a).localeCompare(bindingSortKey(b)));
  }
}
