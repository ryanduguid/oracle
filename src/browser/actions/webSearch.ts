import type { ChromeClient, BrowserLogger } from "../types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import {
  COMPOSER_TOOLS_MENU_SELECTOR,
  INPUT_SELECTORS,
  WEB_SEARCH_ACTIVE_CHIP_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import {
  activateComposerPlus,
  captureComposerNavigationUrl,
  assertComposerPlusStayedInPlace,
} from "./attachments.js";
import { buildComposerNavigationValidationExpression } from "./attachmentContext.js";
import { buildClickDispatcher } from "./domEvents.js";

export function matchesWebSearchMenuLabel(value: string): boolean {
  return [
    "search",
    "searchfindontheweb",
    "websearch",
    "websearchfindreal-timenewsandinfo",
  ].includes(value.replace(/\s+/g, "").toLowerCase());
}

export function buildWebSearchVerificationExpression(prompt: string): string {
  return `(() => {
    const visible = node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const editor = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visible);
    if (!editor) return { selected: false, promptMatches: false };
    // Older layout: an inline pill inside the editor. September 2026: a removable
    // "Web search" chip beside the editor, inside the same composer form.
    const inlinePill = editor.querySelector('[data-inline-selection-pill][data-id="search"][data-system-hint-type="search"]');
    const composer = editor.closest('form') || document;
    const chip = inlinePill || Array.from(composer.querySelectorAll('${WEB_SEARCH_ACTIVE_CHIP_SELECTOR}')).find(visible) || null;
    const copy = editor.cloneNode(true);
    copy.querySelectorAll('[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]').forEach(node => node.remove());
    const readText = node => {
      if (node.nodeType === 3) return node.textContent ?? '';
      const text = Array.from(node.childNodes).map(readText).join('');
      return text + (['P', 'DIV', 'BR', 'LI', 'PRE'].includes(node.nodeName) ? '\\n' : '');
    };
    const normalize = text => String(text ?? '').replace(/[\\u200b\\ufeff]/g, '').replace(/\\s+/g, ' ').trim();
    return { selected: Boolean(chip && visible(chip)), promptMatches: normalize(readText(copy)) === normalize(${JSON.stringify(prompt)}) };
  })()`;
}

export function buildWebSearchSelectionExpression(navigationUrl: string): string {
  return `(() => {
    ${buildClickDispatcher()}
    const matchesLabel = ${matchesWebSearchMenuLabel.toString()};
    const navigation = ${buildComposerNavigationValidationExpression(navigationUrl)};
    if (!navigation.contextMatches || navigation.workSelected || navigation.modeUnverified) return 'context-changed';
    const visible = node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const roots = Array.from(document.querySelectorAll('main .popover, [data-radix-popper-content-wrapper], [data-floating-ui-portal], [role="menu"], [role="listbox"], ${COMPOSER_TOOLS_MENU_SELECTOR}')).filter(visible);
    // September 2026 menu entries are plain buttons whose text is the label plus its description.
    const candidates = roots.flatMap(root => Array.from(root.querySelectorAll('[data-radix-collection-item], [role="menuitem"], [role="option"], .__menu-item, [class*="menu-item"], button')));
    const match = candidates.find(node => {
      if (!visible(node) || node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') return false;
      return matchesLabel(node.textContent ?? '');
    });
    if (!match) return 'missing';
    dispatchClickSequence(match);
    return 'clicked';
  })()`;
}

/** Web Search is an inline editor hint, so activate it after staging text/attachments. */
export async function activateWebSearch(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"],
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  const navigationUrl = await captureComposerNavigationUrl(runtime);
  const verify = async () => {
    const { result, exceptionDetails } = await runtime.evaluate({
      expression: buildWebSearchVerificationExpression(prompt),
      returnByValue: true,
    });
    if (exceptionDetails) return false;
    return result?.value?.selected === true && result?.value?.promptMatches === true;
  };
  if (await verify()) return;
  const activated = await activateComposerPlus(runtime, input, navigationUrl);
  if (activated.method === "unavailable")
    throw new BrowserAutomationError("Web Search requires the ChatGPT composer tools menu.", {
      stage: "web-search-activate",
    });
  const deadline = Date.now() + 5_000;
  let clicked = false;
  while (Date.now() < deadline) {
    const outcome = await runtime.evaluate({
      expression: buildWebSearchSelectionExpression(navigationUrl),
      returnByValue: true,
    });
    if (outcome.result?.value === "clicked") {
      clicked = true;
      break;
    }
    if (outcome.exceptionDetails || outcome.result?.value !== "missing") break;
    await delay(100);
  }
  if (clicked) {
    const confirmationDeadline = Date.now() + 3_000;
    do {
      await assertComposerPlusStayedInPlace(runtime, navigationUrl);
      if (await verify()) {
        logger("Web Search selected; inline search hint and staged prompt verified.");
        return;
      }
      await delay(100);
    } while (Date.now() < confirmationDeadline);
  }
  throw new BrowserAutomationError(
    "Web Search selection could not be verified; the prompt was not submitted. This pilot supports the English ChatGPT Web search control.",
    { stage: "web-search-activate" },
  );
}
