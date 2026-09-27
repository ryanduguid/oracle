import type { BrowserLogger, ChromeClient } from "./types.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { MODEL_BUTTON_SELECTOR } from "./constants.js";
import { delay } from "./utils.js";

/**
 * Detection and recovery for a ChatGPT tab whose model list failed to load.
 *
 * Seen live on 27 September 2026, four times in one day across two agents: the
 * composer's model button renders "Could not load ChatGPT models" instead of the
 * model pill, its menu holds no real options, and the effort picker never mounts.
 * Read from the model picker that state surfaced as
 * `Unable to find model option matching "Latest" ... Available: Select ChatGPT model, GPT-5`;
 * read from the effort picker as `Thinking time: menu not found (requested Pro)`.
 * Both messages send the reader after a selector bug that does not exist. The
 * page itself is broken, and a reload fixes it: every rerun of those sessions
 * completed.
 */

export const MODELS_NOT_LOADED_STAGE = "chatgpt-models-not-loaded";

const MODELS_LOAD_FAILURE_PHRASES = [
  "could not load chatgpt models",
  "couldn't load chatgpt models",
  "could not load models",
  "couldn't load models",
] as const;

export interface ModelsLoadFailureNotice {
  /** The notice text as shown, trimmed and length-bounded. */
  message: string;
  /** Where the notice was read from. */
  where: "model-button" | "menu";
}

/** True when the text carries ChatGPT's failed-model-list wording. */
export function matchesModelsLoadFailure(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return MODELS_LOAD_FAILURE_PHRASES.some((phrase) => normalized.includes(phrase));
}

export function buildModelsLoadFailureProbeExpression(): string {
  return `(() => {
    const PHRASES = ${JSON.stringify(MODELS_LOAD_FAILURE_PHRASES)};
    const BUTTON_SELECTOR = ${JSON.stringify(MODEL_BUTTON_SELECTOR)};
    const matches = (value) => {
      const text = (value || '').toLowerCase();
      return PHRASES.some((phrase) => text.includes(phrase));
    };
    const trimmed = (value) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
    // The model button first: that is where the failure was observed. It carries
    // aria-hidden measurement text, so innerText is preferred for the message.
    const button = document.querySelector(BUTTON_SELECTOR);
    if (button && matches(button.textContent)) {
      return { message: trimmed(button.innerText || button.textContent), where: 'model-button' };
    }
    // Then the picker's own open menu. The conversation is never searched: a
    // chat about this very failure would otherwise read as the failure itself.
    const menus = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper]'));
    for (const menu of menus) {
      const text = menu.innerText || '';
      if (matches(text)) return { message: trimmed(text), where: 'menu' };
    }
    return null;
  })()`;
}

/**
 * Looks for the failed-model-list notice. Never throws: this runs on paths that
 * are already reporting a different failure, and a probe that failed must not
 * replace the original diagnosis with its own.
 */
export async function detectModelsLoadFailure(
  Runtime: ChromeClient["Runtime"],
): Promise<ModelsLoadFailureNotice | null> {
  try {
    const evaluated = await Runtime.evaluate({
      expression: buildModelsLoadFailureProbeExpression(),
      returnByValue: true,
    });
    const value = evaluated.result?.value as
      | { message?: string; where?: ModelsLoadFailureNotice["where"] }
      | null
      | undefined;
    if (value && typeof value.message === "string" && value.message.trim()) {
      return { message: value.message.trim(), where: value.where ?? "menu" };
    }
  } catch {
    // fall through: no notice detected
  }
  return null;
}

export class ChatGptModelsNotLoadedError extends BrowserAutomationError {
  constructor(notice: ModelsLoadFailureNotice, context: { stage: string }) {
    super(
      `ChatGPT could not load its model list (${notice.message}). ` +
        "The page is broken, not the request: reload the tab and retry.",
      {
        stage: MODELS_NOT_LOADED_STAGE,
        details: {
          // Named so a caller can branch on it rather than parsing the message.
          retryable: true,
          reloadRecommended: true,
          origin: context.stage,
          notice: notice.message,
          where: notice.where,
        },
      },
    );
    this.name = "ChatGptModelsNotLoadedError";
  }
}

export function isModelsNotLoadedError(error: unknown): boolean {
  if (error instanceof ChatGptModelsNotLoadedError) return true;
  const stage = (error as { details?: { stage?: unknown } } | null)?.details?.stage;
  return stage === MODELS_NOT_LOADED_STAGE;
}

/**
 * Replaces a misleading picker failure with the real one when the model list
 * never loaded. Returns nothing otherwise, leaving the caller's own error intact.
 */
export async function throwIfModelsNotLoaded(
  Runtime: ChromeClient["Runtime"],
  context: { stage: string },
  logger?: BrowserLogger,
): Promise<void> {
  const notice = await detectModelsLoadFailure(Runtime);
  if (!notice) {
    return;
  }
  logger?.(
    `[browser] ChatGPT model list failed to load during ${context.stage} (${notice.where}): ${notice.message}`,
  );
  throw new ChatGptModelsNotLoadedError(notice, context);
}

export interface ModelsReloadRetryOptions {
  /** Reloads the tab and waits for the composer; called before each retry. */
  reload: () => Promise<void>;
  /** How many reloads to try before giving up (default 2). */
  attempts?: number;
  /** Base delay before a reload; multiplied by the attempt number (default 2 s). */
  delayMs?: number;
  logger?: BrowserLogger;
  /** Injected for tests. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Runs the composer set-up (model picker, effort picker) and, when it fails
 * because the model list never loaded, reloads the page and runs it again.
 * Any other error passes through untouched.
 */
export async function retryAfterReloadWhenModelsNotLoaded<T>(
  task: () => Promise<T>,
  options: ModelsReloadRetryOptions,
): Promise<T> {
  const attempts = Math.max(0, options.attempts ?? 2);
  const delayMs = Math.max(0, options.delayMs ?? 2000);
  const wait = options.wait ?? delay;
  let attempt = 0;
  for (;;) {
    try {
      return await task();
    } catch (error) {
      if (!isModelsNotLoadedError(error) || attempt >= attempts) {
        throw error;
      }
      attempt += 1;
      const notice = (error as { details?: { details?: { notice?: unknown } } }).details?.details
        ?.notice;
      options.logger?.(
        `[browser] ChatGPT could not load its model list${typeof notice === "string" ? ` (${notice})` : ""}; reloading the page and retrying (${attempt}/${attempts}).`,
      );
      await wait(delayMs * attempt);
      await options.reload();
    }
  }
}
