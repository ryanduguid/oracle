import { describe, expect, it } from "vitest";
import {
  COMPOSER_PLUS_SELECTOR,
  COMPOSER_TOOLS_MENU_SELECTOR,
  WEB_SEARCH_ACTIVE_CHIP_SELECTOR,
} from "../../src/browser/constants.js";
import { activateComposerPlus } from "../../src/browser/actions/attachments.js";
import {
  buildWebSearchSelectionExpression,
  buildWebSearchVerificationExpression,
  matchesWebSearchMenuLabel,
} from "../../src/browser/actions/webSearch.js";
import { buildActivateDeepResearchExpressionForTest } from "../../src/browser/actions/deepResearch.js";

// Attributes read from the live ChatGPT composer on 27 September 2026 (probe
// over CDP on an Oracle-owned tab): the "+" button has no id or test id, only
// `aria-label="Add files and more"`; its menu is a fixed div whose class starts
// with "ComposerTopMenuShell" and whose entries are plain buttons reading
// "Web searchFind real-time news and info" and "Deep researchGet a detailed
// report"; a selected Web search shows as `button[aria-label="Remove Web search"]`.
const SEPTEMBER_PLUS = 'form button[aria-label="Add files and more"]';

describe("September 2026 composer tools", () => {
  it("keeps the legacy composer-plus selectors and adds the labelled button", () => {
    expect(COMPOSER_PLUS_SELECTOR).toContain("#composer-plus-btn");
    expect(COMPOSER_PLUS_SELECTOR).toContain('button[data-testid="composer-plus-btn"]');
    expect(COMPOSER_PLUS_SELECTOR).toContain(SEPTEMBER_PLUS);
  });

  it("probes for the labelled button and guards activation with the same selectors", async () => {
    const expressions: string[] = [];
    const runtime = {
      evaluate: async ({ expression }: { expression: string }) => {
        expressions.push(expression);
        // First call: the probe finds and focuses the button. Later calls: the
        // guard preparation and its summary, both satisfied.
        const value =
          expressions.length === 1
            ? { status: "focused", startUrl: "https://chatgpt.com/", focused: true }
            : {
                currentUrl: "https://chatgpt.com/",
                contextMatches: true,
                focused: true,
                sawKeyDown: false,
                clicked: true,
                blocked: null,
              };
        return { result: { value } };
      },
    };
    const result = await activateComposerPlus(runtime as never);
    expect(result.method).toBe("synthetic");
    expect(expressions[0]).toContain(SEPTEMBER_PLUS);
    // The event-time guard must accept the same button the probe found; before
    // this it re-queried the two legacy selectors only and refused the new one.
    expect(expressions[1]).toContain(
      `document.querySelector('${COMPOSER_PLUS_SELECTOR}') === button`,
    );
  });

  it("selects Web search from the September menu shell", () => {
    const expression = buildWebSearchSelectionExpression("https://chatgpt.com/");
    expect(expression).toContain(COMPOSER_TOOLS_MENU_SELECTOR);
    expect(expression).toContain('[class*="menu-item"], button');
    expect(matchesWebSearchMenuLabel("Web searchFind real-time news and info")).toBe(true);
    expect(matchesWebSearchMenuLabel("Web search")).toBe(true);
    expect(matchesWebSearchMenuLabel("Deep researchGet a detailed report")).toBe(false);
    expect(matchesWebSearchMenuLabel("Search apps")).toBe(false);
  });

  it("verifies Web search through the removable chip as well as the inline pill", () => {
    const expression = buildWebSearchVerificationExpression("hello");
    expect(expression).toContain('[data-inline-selection-pill][data-id="search"]');
    expect(expression).toContain(WEB_SEARCH_ACTIVE_CHIP_SELECTOR);
    expect(expression).toContain("editor.closest('form')");
  });

  it("treats the September menu shell as a popover for Deep research", () => {
    const expression = buildActivateDeepResearchExpressionForTest();
    expect(expression).toContain(COMPOSER_TOOLS_MENU_SELECTOR);
    expect(expression).toContain("add files");
  });
});
