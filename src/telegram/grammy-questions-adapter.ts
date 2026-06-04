import type { UserInteractionPort } from "../agent/tools/user-question-port.ts";
import { createTelegramUserInteractionPort } from "./telegram-user-interaction.ts";

export { createTelegramUserInteractionPort };

/** @deprecated Use createTelegramUserInteractionPort */
export type AskUserQuestionPort = UserInteractionPort;

/** @deprecated Use createTelegramUserInteractionPort */
export const createTelegramAskUserQuestionPort = createTelegramUserInteractionPort;
