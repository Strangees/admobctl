import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configDir, loadConfig, resolveProfile, saveConfig, setProfileValue } from "../src/core/config.js";
import { log } from "../src/core/log.js";

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
    setProfileValue(cfg, "default", "websites.quiz-android", "example.com");
    expect(cfg).toEqual({
      profiles: {
        default: {
          finance: { revenueAccount: "3100", decimalSeparator: "," },
          aliases: { quiz: "ca-app-pub-1~2" },
          websites: { "quiz-android": "example.com" },
          quotaProject: "my-proj",
        },
      },
    });
    expect(() => setProfileValue(cfg, "default", "password", "x")).toThrow(/Unknown config key/);
    expect(() => setProfileValue(cfg, "default", "authMode", "magic")).toThrow(/authMode/);
    expect(() => setProfileValue(cfg, "default", "finance.decimalSeparator", ";")).toThrow(/decimalSeparator/);
  });

  describe("config dir permissions", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A pre-existing dir with an explicit (umask-proof) 0755 mode. */
    const looseDir = (name: string) => {
      const dir = join(tmp(), name);
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      return dir;
    };

    it.skipIf(process.platform === "win32")("creates a missing dir as 0700", () => {
      const dir = join(tmp(), "fresh", ".admobctl");
      saveConfig(dir, { profiles: {} });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    it.skipIf(process.platform === "win32")("tightens a pre-existing loose .admobctl dir to 0700", () => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      const dir = looseDir(".admobctl");
      saveConfig(dir, { profiles: {} });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(warn).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === "win32")("leaves any other loose dir alone and warns with the fix", () => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      const dir = looseDir("shared");
      saveConfig(dir, { profiles: {} });
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(`chmod 700 ${dir}`);
    });
  });
});

describe("features in the profile", () => {
  it("stores a parsed feature list and rejects unknown ones", () => {
    const cfg = { profiles: {} };
    setProfileValue(cfg, "default", "features", "payments,write");
    expect(resolveProfile(cfg).features).toEqual(["read", "write", "payments"]);
    expect(() => setProfileValue(cfg, "default", "features", "nope")).toThrow(/Unknown feature/);
    setProfileValue(cfg, "default", "features", undefined);
    expect(resolveProfile(cfg).features).toBeUndefined();
  });
});
