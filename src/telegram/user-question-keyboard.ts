import { InlineKeyboard } from "grammy";

import {
  assertCallbackFits,
  encodeCancelCallback,
  encodeDoneCallback,
  encodeOptionCallback,
  encodeOtherCallback,
  encodeToggleCallback,
} from "./user-question-callback.ts";

/**
 * Builds inline keyboard for single-select + Other + Cancel.
 * @internal
 */
export function buildSingleSelectKeyboard(
  sessionId: number,
  labels: string[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < labels.length; i++) {
    const data = encodeOptionCallback(sessionId, i);
    assertCallbackFits(data);
    keyboard.text(labels[i] ?? `Option ${i + 1}`, data).row();
  }
  const otherData = encodeOtherCallback(sessionId);
  const cancelData = encodeCancelCallback(sessionId);
  assertCallbackFits(otherData);
  assertCallbackFits(cancelData);
  keyboard.text("Other", otherData).text("Cancel", cancelData);
  return keyboard;
}

/**
 * Builds inline keyboard for multi-select with current selection state.
 * @internal
 */
export function buildMultiSelectKeyboard(
  sessionId: number,
  labels: string[],
  selected: Set<number>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < labels.length; i++) {
    const prefix = selected.has(i) ? "[x] " : "";
    const data = encodeToggleCallback(sessionId, i);
    assertCallbackFits(data);
    keyboard.text(`${prefix}${labels[i] ?? `Option ${i + 1}`}`, data).row();
  }
  const doneData = encodeDoneCallback(sessionId);
  const cancelData = encodeCancelCallback(sessionId);
  assertCallbackFits(doneData);
  assertCallbackFits(cancelData);
  keyboard.text("Done", doneData).text("Cancel", cancelData);
  return keyboard;
}
