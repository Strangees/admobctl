import { describe, expect, it } from "vitest";
import { apisFor, featureForService, featuresFromScopes, parseFeatures, scopesFor } from "../src/core/setup/features.js";

const READ = "https://www.googleapis.com/auth/admob.readonly";
const WRITE = "https://www.googleapis.com/auth/admob.monetization";
const ADSENSE = "https://www.googleapis.com/auth/adsense.readonly";
const CLOUD = "https://www.googleapis.com/auth/cloud-platform";

describe("features", () => {
  it("parses a feature list, always including read, in a fixed order", () => {
    expect(parseFeatures("payments,write")).toEqual(["read", "write", "payments"]);
    expect(parseFeatures(["write", "write"])).toEqual(["read", "write"]);
    expect(parseFeatures(undefined)).toEqual(["read"]);
    expect(parseFeatures(" payments ")).toEqual(["read", "payments"]);
  });

  it("rejects unknown feature names", () => {
    expect(() => parseFeatures("x")).toThrow(/Unknown feature "x"/);
  });

  it("detects features from granted scopes", () => {
    expect(featuresFromScopes([READ, ADSENSE])).toEqual(["read", "payments"]);
    expect(featuresFromScopes([READ, WRITE, CLOUD])).toEqual(["read", "write"]);
    expect(featuresFromScopes([])).toEqual([]);
  });

  it("lists the scopes and APIs a feature set needs", () => {
    expect(scopesFor(["read", "payments"])).toEqual([READ, ADSENSE, CLOUD]);
    expect(scopesFor(["read", "write", "payments"])).toEqual([READ, WRITE, ADSENSE, CLOUD]);
    expect(apisFor(["read", "payments"])).toEqual(["admob.googleapis.com", "adsense.googleapis.com"]);
    expect(apisFor(["read", "write"])).toEqual(["admob.googleapis.com"]);
  });

  it("maps a Google service to the feature that needs it", () => {
    expect(featureForService("adsense.googleapis.com")).toBe("payments");
    expect(featureForService("admob.googleapis.com")).toBe("read");
    expect(featureForService("other.googleapis.com")).toBeUndefined();
  });
});
