import { describe, expect, it } from "vitest";
import { appsView } from "../src/cli/views.js";
import { approvalLabel, type AppRef } from "../src/core/aliases.js";

const app = (alias: string, approval?: string): AppRef => ({ alias, appId: `id-${alias}`, name: alias, platform: "IOS", resource: `r/${alias}`, approval });

describe("approval state", () => {
  it("labels the API states in plain words", () => {
    expect(approvalLabel("APPROVED")).toBe("approved");
    expect(approvalLabel("IN_REVIEW")).toBe("in review");
    expect(approvalLabel("ACTION_REQUIRED")).toBe("action required");
    expect(approvalLabel(undefined)).toBe("");
    expect(approvalLabel("APP_APPROVAL_STATE_UNSPECIFIED")).toBe("");
  });

  it("notes apps that need action under the apps table", () => {
    const out = appsView([app("quiz-ios", "APPROVED"), app("timer-android", "ACTION_REQUIRED")]);
    expect(out.table.rows[1]!.approval).toBe("action required");
    expect(out.notes?.join("\n")).toMatch(/timer-android needs? action/);
  });
});
