import { describe, expect, it } from "vitest";
import { buildAppIndex, resolveApp, slugify } from "../src/core/aliases.js";
import type { App } from "../src/core/client.js";
import { fixture } from "./helpers.js";

const apps = [
  ...fixture<{ apps: App[] }>("apps-page1.json").apps,
  ...fixture<{ apps: App[] }>("apps-page2.json").apps,
];

describe("slugify", () => {
  it("makes short, shell-friendly aliases", () => {
    expect(slugify("Sample Timer: Focus & Breaks")).toBe("sample-timer-focus-breaks");
    expect(slugify("Blåbær Ølsmaking")).toBe("blabaer-olsmaking");
    expect(slugify("  --Ünïcode!!  ")).toBe("unicode");
  });
});

describe("buildAppIndex", () => {
  it("derives name-platform aliases", () => {
    const idx = buildAppIndex(apps);
    expect(idx.map((a) => a.alias)).toEqual(["example-quiz-ios", "example-quiz-android", "sample-timer-focus-breaks-ios"]);
    expect(idx[1]).toMatchObject({
      appId: "ca-app-pub-0000000000000001~2222222222",
      name: "Example Quiz",
      platform: "ANDROID",
      storeId: "com.example.quiz",
    });
  });

  it("applies configured overrides", () => {
    const idx = buildAppIndex(apps, { timer: "ca-app-pub-0000000000000001~3333333333" });
    expect(idx[2]!.alias).toBe("timer");
  });

  it("disambiguates collisions deterministically", () => {
    const dupes = [apps[0]!, { ...apps[0]!, appId: "ca-app-pub-0000000000000001~9999999999" }];
    expect(buildAppIndex(dupes).map((a) => a.alias)).toEqual(["example-quiz-ios", "example-quiz-ios-2"]);
  });
});

describe("resolveApp", () => {
  const idx = buildAppIndex(apps, { timer: "ca-app-pub-0000000000000001~3333333333" });

  it("resolves by alias, app ID, numeric suffix or unique name", () => {
    expect(resolveApp("example-quiz-ios", idx).appId).toBe("ca-app-pub-0000000000000001~1111111111");
    expect(resolveApp("ca-app-pub-0000000000000001~2222222222", idx).alias).toBe("example-quiz-android");
    expect(resolveApp("3333333333", idx).alias).toBe("timer");
    expect(resolveApp("sample timer: focus & breaks", idx).alias).toBe("timer");
  });

  it("rejects ambiguous names and lists the options", () => {
    expect(() => resolveApp("Example Quiz", idx)).toThrow(/ambiguous.*example-quiz-ios.*example-quiz-android/i);
  });

  it("lists known aliases on a miss", () => {
    expect(() => resolveApp("nope", idx)).toThrow(/Known apps: example-quiz-ios/);
  });
});
