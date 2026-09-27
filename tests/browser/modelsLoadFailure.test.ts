import { describe, expect, it } from "vitest";
import {
  ChatGptModelsNotLoadedError,
  MODELS_NOT_LOADED_STAGE,
  buildModelsLoadFailureProbeExpression,
  detectModelsLoadFailure,
  isModelsNotLoadedError,
  matchesModelsLoadFailure,
  retryAfterReloadWhenModelsNotLoaded,
} from "../../src/browser/modelsLoadFailure.js";
import { ensureModelSelection } from "../../src/browser/actions/modelSelection.js";
import { ensureThinkingTime } from "../../src/browser/actions/thinkingTime.js";

// The model button text observed live on 27 September 2026 while the effort
// picker reported "menu not found": the visible label and its aria-hidden
// measurement copy, concatenated by textContent.
const LIVE_BUTTON_TEXT = "Could not load ChatGPT modelsCould not load ChatGPT models";
const PROBE_MARKER = "could not load chatgpt models";

function runtimeWithNotice(pickerResult: unknown, notice: string | null) {
  const calls: string[] = [];
  return {
    calls,
    evaluate: async ({ expression }: { expression: string }) => {
      calls.push(expression);
      if (expression.includes(PROBE_MARKER)) {
        return { result: { value: notice ? { message: notice, where: "model-button" } : null } };
      }
      return { result: { value: pickerResult } };
    },
  };
}

describe("ChatGPT failed model list", () => {
  it("recognises the notice as shown", () => {
    expect(matchesModelsLoadFailure(LIVE_BUTTON_TEXT)).toBe(true);
    expect(matchesModelsLoadFailure("Couldn't load ChatGPT models")).toBe(true);
  });

  it("does not fire on ordinary picker text", () => {
    expect(matchesModelsLoadFailure("Thinking effortPro")).toBe(false);
    expect(matchesModelsLoadFailure("Select ChatGPT model")).toBe(false);
    expect(matchesModelsLoadFailure("GPT-5")).toBe(false);
    expect(matchesModelsLoadFailure("")).toBe(false);
    expect(matchesModelsLoadFailure(undefined)).toBe(false);
  });

  it("probes the model button, then open menus, and never the conversation", () => {
    const expression = buildModelsLoadFailureProbeExpression();
    expect(expression).toContain('aria-label=\\"Select ChatGPT model\\"');
    expect(expression.indexOf("querySelector(BUTTON_SELECTOR)")).toBeLessThan(
      expression.indexOf('[role="menu"]'),
    );
    // A consult about this failure would otherwise be read as the failure itself.
    expect(expression).not.toContain("document.body");
  });

  it("returns nothing rather than throwing when the probe itself fails", async () => {
    const notice = await detectModelsLoadFailure({
      evaluate: async () => {
        throw new Error("target closed");
      },
    } as never);
    expect(notice).toBeNull();
  });

  it("marks the error retryable with a reload recommendation", () => {
    const error = new ChatGptModelsNotLoadedError(
      { message: LIVE_BUTTON_TEXT, where: "model-button" },
      { stage: "model-selection" },
    );
    expect(error.details?.stage).toBe(MODELS_NOT_LOADED_STAGE);
    expect(error.details?.details).toMatchObject({
      retryable: true,
      reloadRecommended: true,
      origin: "model-selection",
    });
    expect(isModelsNotLoadedError(error)).toBe(true);
    expect(isModelsNotLoadedError({ details: { stage: MODELS_NOT_LOADED_STAGE } })).toBe(true);
    expect(isModelsNotLoadedError(new Error("Unable to find model option"))).toBe(false);
  });
});

describe("model selection when the model list never loaded", () => {
  it("reports the broken page instead of a missing model", async () => {
    // Before this, the run failed with:
    //   Unable to find model option matching "Latest" ... Available: Select ChatGPT model, GPT-5.
    const runtime = runtimeWithNotice(
      {
        status: "option-not-found",
        hint: { availableOptions: ["Select ChatGPT model", "GPT-5"], temporaryChat: false },
      },
      LIVE_BUTTON_TEXT,
    );
    await expect(
      ensureModelSelection(runtime as never, "Latest", (() => {}) as never, "select"),
    ).rejects.toMatchObject({ details: { stage: MODELS_NOT_LOADED_STAGE } });
  });

  it("still blames the model when the list loaded", async () => {
    const runtime = runtimeWithNotice(
      {
        status: "option-not-found",
        hint: { availableOptions: ["Latest", "GPT-5.6 Sol"], temporaryChat: false },
      },
      null,
    );
    await expect(
      ensureModelSelection(runtime as never, "gpt-4o", (() => {}) as never, "select"),
    ).rejects.toThrow(/Unable to find model option matching "gpt-4o"/);
  });
});

describe("thinking time when the model list never loaded", () => {
  it("reports the broken page instead of a missing effort menu", async () => {
    // Before this, a follow-up failed with:
    //   Thinking time: menu not found (requested Pro); refusing to submit without confirmed Pro.
    const runtime = runtimeWithNotice({ status: "menu-not-found" }, LIVE_BUTTON_TEXT);
    await expect(
      ensureThinkingTime(runtime as never, "pro", (() => {}) as never, "Latest"),
    ).rejects.toMatchObject({ details: { stage: MODELS_NOT_LOADED_STAGE } });
  });

  it("keeps the strict Pro refusal when the list loaded", async () => {
    const runtime = runtimeWithNotice({ status: "menu-not-found" }, null);
    await expect(
      ensureThinkingTime(runtime as never, "pro", (() => {}) as never, "Latest"),
    ).rejects.toThrow(/menu not found \(requested Pro\); refusing to submit/);
  });
});

describe("retryAfterReloadWhenModelsNotLoaded", () => {
  const notLoaded = () =>
    new ChatGptModelsNotLoadedError(
      { message: LIVE_BUTTON_TEXT, where: "model-button" },
      { stage: "model-selection" },
    );

  it("reloads and runs the task again until it succeeds", async () => {
    let runs = 0;
    const events: string[] = [];
    const result = await retryAfterReloadWhenModelsNotLoaded(
      async () => {
        runs += 1;
        events.push(`run ${runs}`);
        if (runs < 3) throw notLoaded();
        return "selected";
      },
      {
        reload: async () => {
          events.push("reload");
        },
        wait: async (ms) => {
          events.push(`wait ${ms}`);
        },
        delayMs: 1000,
      },
    );
    expect(result).toBe("selected");
    expect(events).toEqual([
      "run 1",
      "wait 1000",
      "reload",
      "run 2",
      "wait 2000",
      "reload",
      "run 3",
    ]);
  });

  it("gives up after the configured reloads and rethrows the last error", async () => {
    let reloads = 0;
    await expect(
      retryAfterReloadWhenModelsNotLoaded(
        async () => {
          throw notLoaded();
        },
        {
          reload: async () => {
            reloads += 1;
          },
          wait: async () => {},
          attempts: 2,
        },
      ),
    ).rejects.toMatchObject({ details: { stage: MODELS_NOT_LOADED_STAGE } });
    expect(reloads).toBe(2);
  });

  it("passes every other error through without reloading", async () => {
    let reloads = 0;
    await expect(
      retryAfterReloadWhenModelsNotLoaded(
        async () => {
          throw new Error('Unable to find model option matching "gpt-4o"');
        },
        {
          reload: async () => {
            reloads += 1;
          },
          wait: async () => {},
        },
      ),
    ).rejects.toThrow(/Unable to find model option/);
    expect(reloads).toBe(0);
  });
});
