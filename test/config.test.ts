import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDir, loadConfig, resolveProfile, saveConfig, setProfileValue } from "../src/core/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "admobctl-test-"));

describe("config", () => {
  it("uses ADMOBCTL_HOME when set, else ~/.admobctl", () => {
    expect(configDir({ ADMOBCTL_HOME: "/x/y" }, "/home/u")).toBe("/x/y");
    expect(configDir({}, "/home/u")).toBe(join("/home/u", ".admobctl"));
  });

  it("returns an empty config when the file does not exist", () => {
    expect(loadConfig(tmp())).toEqual({ profiles: {} });
  });

  it("applies defaults when resolving a profile", () => {
    const p = resolveProfile({ profiles: {} });
    expect(p.name).toBe("default");
    expect(p.authMode).toBe("auto");
    expect(p.finance).toMatchObject({ receivableAccount: "1509", revenueAccount: "3120", decimalSeparator: "." });
  });

  it("selects the named or default profile", () => {
    const cfg = {
      defaultProfile: "work",
      profiles: { work: { account: "pub-1" }, other: { account: "pub-2", finance: { revenueAccount: "3100" } } },
    };
    expect(resolveProfile(cfg).account).toBe("pub-1");
    const other = resolveProfile(cfg, "other");
    expect(other.account).toBe("pub-2");
    expect(other.finance).toMatchObject({ receivableAccount: "1509", revenueAccount: "3100" });
  });

  it("errors on an unknown explicit profile", () => {
    expect(() => resolveProfile({ profiles: {} }, "nope")).toThrow(/Unknown profile/);
  });

  it("saves with owner-only permissions and round-trips", () => {
    const dir = join(tmp(), "nested");
    saveConfig(dir, { profiles: { default: { account: "pub-1" } } });
    expect(loadConfig(dir).profiles.default?.account).toBe("pub-1");
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toMatch(/\n$/);
  });

  it("sets dotted keys and rejects unknown ones", () => {
    const cfg = { profiles: {} };
    setProfileValue(cfg, "default", "finance.revenueAccount", "3100");
    setProfileValue(cfg, "default", "aliases.quiz", "ca-app-pub-1~2");
    setProfileValue(cfg, "default", "quotaProject", "my-proj");
    setProfileValue(cfg, "default", "finance.decimalSeparator", ",");
    expect(cfg).toEqual({
      profiles: {
        default: {
          finance: { revenueAccount: "3100", decimalSeparator: "," },
          aliases: { quiz: "ca-app-pub-1~2" },
          quotaProject: "my-proj",
        },
      },
    });
    expect(() => setProfileValue(cfg, "default", "password", "x")).toThrow(/Unknown config key/);
    expect(() => setProfileValue(cfg, "default", "authMode", "magic")).toThrow(/authMode/);
    expect(() => setProfileValue(cfg, "default", "finance.decimalSeparator", ";")).toThrow(/decimalSeparator/);
  });
});
