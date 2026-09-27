import { describe, expect, test } from "vitest";
import {
  classifyChromeDisconnect,
  connectionLostUserMessage,
  isRecoverableChromeDisconnect,
} from "../../src/browser/cdpLiveness.ts";

// On 27 September 2026 a session whose Chrome stayed alive reported "Chrome
// window closed" because the target list failed after its client dropped.
describe("classifyChromeDisconnect", () => {
  test("a live target is a client disconnect and the only recoverable state", () => {
    const liveness = { endpointReachable: true, targetFound: true as const };
    expect(classifyChromeDisconnect(liveness)).toBe("cdp-client-disconnect");
    expect(isRecoverableChromeDisconnect(liveness)).toBe(true);
  });

  test("an unreachable endpoint is Chrome closed", () => {
    const liveness = { endpointReachable: false, targetFound: null, error: "ECONNREFUSED" };
    expect(classifyChromeDisconnect(liveness)).toBe("chrome-closed");
    expect(isRecoverableChromeDisconnect(liveness)).toBe(false);
  });

  test("a missing target with a live endpoint is the tab closing, not the window", () => {
    const liveness = { endpointReachable: true, targetFound: false as const };
    expect(classifyChromeDisconnect(liveness)).toBe("target-closed");
    expect(isRecoverableChromeDisconnect(liveness)).toBe(false);
    expect(connectionLostUserMessage({ recoverable: false, cause: "target-closed" })).toContain(
      "still running",
    );
  });

  test("a failed target list is unknown: fail closed without claiming Chrome closed", () => {
    const liveness = { endpointReachable: true, targetFound: null, error: "target list timeout" };
    expect(classifyChromeDisconnect(liveness)).toBe("liveness-unknown");
    expect(isRecoverableChromeDisconnect(liveness)).toBe(false);
    const message = connectionLostUserMessage({ recoverable: false, cause: "liveness-unknown" });
    expect(message).toContain("could not be confirmed");
    expect(message).not.toContain("window closed");
  });

  test("an endpoint-only probe with no error is a client disconnect", () => {
    expect(classifyChromeDisconnect({ endpointReachable: true, targetFound: null })).toBe(
      "cdp-client-disconnect",
    );
  });

  test("messages without a cause keep their historical wording", () => {
    expect(connectionLostUserMessage({ recoverable: true })).toContain("still alive");
    expect(connectionLostUserMessage({ recoverable: false })).toContain("Chrome window closed");
    expect(connectionLostUserMessage({ recoverable: false, remote: true })).toContain("Remote");
  });
});
