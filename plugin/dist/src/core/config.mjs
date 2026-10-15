import { AdmobctlError, usageError } from "./errors.mjs";
import { parseFeatures } from "./setup/features.mjs";
import { ensurePrivateDir } from "./fs.mjs";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

//#region src/core/config.ts
const DEFAULT_FINANCE = {
	receivableAccount: "1509",
	revenueAccount: "3120",
	receivableAccountName: "Fordring AdMob",
	revenueAccountName: "Annonseinntekter AdMob",
	vatTreatment: "",
	counterparty: "Google Ireland Limited",
	decimalSeparator: "."
};
function configDir(env = process.env, home = homedir()) {
	return env.ADMOBCTL_HOME || join(home, ".admobctl");
}
function configPath(dir) {
	return join(dir, "config.json");
}
function loadConfig(dir) {
	const file = configPath(dir);
	if (!existsSync(file)) return { profiles: {} };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return {
			...parsed,
			profiles: parsed.profiles ?? {}
		};
	} catch (err) {
		throw new AdmobctlError("CONFIG", `Could not parse ${file}: ${err.message}`, { fix: `Fix or delete ${file}` });
	}
}
function saveConfig(dir, config) {
	ensurePrivateDir(dir);
	const file = configPath(dir);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 384 });
	renameSync(tmp, file);
	chmodSync(file, 384);
}
function resolveProfile(config, name) {
	const profileName = name ?? config.defaultProfile ?? "default";
	const p = config.profiles[profileName];
	if (!p && name !== void 0 && name !== "default") {
		const known = Object.keys(config.profiles);
		throw usageError(`Unknown profile "${name}". Known profiles: ${known.length ? known.join(", ") : "(none)"}`);
	}
	return {
		...p,
		name: profileName,
		authMode: p?.authMode ?? "auto",
		finance: {
			...DEFAULT_FINANCE,
			...p?.finance
		},
		financeConfigured: { ...p?.finance },
		aliases: { ...p?.aliases }
	};
}
const SCALAR_KEYS = /* @__PURE__ */ new Set([
	"account",
	"quotaProject",
	"authMode",
	"oauthClientId",
	"website"
]);
const CHECK_KEYS = [
	"check.window",
	"check.baseline",
	"check.drop",
	"check.minRequests"
];
const MAP_KEYS = /* @__PURE__ */ new Set([...Object.keys(DEFAULT_FINANCE).map((k) => `finance.${k}`), ...CHECK_KEYS]);
const AUTH_MODES = [
	"auto",
	"adc",
	"oauth"
];
const SETTABLE_KEYS = [
	...SCALAR_KEYS,
	"features",
	...MAP_KEYS,
	"aliases.<alias>",
	"websites.<alias>"
];
/** Set (or with value undefined, unset) a dotted key on a profile. */
function setProfileValue(config, profile, key, value) {
	const p = config.profiles[profile] ??= {};
	if (key === "features") {
		if (value === void 0) delete p.features;
		else p.features = parseFeatures(value);
		return;
	}
	if (SCALAR_KEYS.has(key)) {
		if (key === "authMode" && value !== void 0 && !AUTH_MODES.includes(value)) throw usageError(`authMode must be one of ${AUTH_MODES.join(", ")}`);
		if (value === void 0) delete p[key];
		else p[key] = value;
		return;
	}
	if (key === "finance.decimalSeparator" && value !== void 0 && value !== "." && value !== ",") throw usageError("finance.decimalSeparator must be \".\" or \",\"");
	if (CHECK_KEYS.includes(key) && value !== void 0 && !/^[1-9]\d*$/.test(value)) throw usageError(`${key} must be a positive whole number, got "${value}"`);
	const [head, sub, ...rest] = key.split(".");
	if (rest.length === 0 && sub && (MAP_KEYS.has(key) || head === "aliases" || head === "websites")) {
		const target = p[head] ??= {};
		if (value === void 0) delete target[sub];
		else target[sub] = value;
		return;
	}
	throw usageError(`Unknown config key "${key}". Settable keys: ${SETTABLE_KEYS.join(", ")}`);
}

//#endregion
export { DEFAULT_FINANCE, SETTABLE_KEYS, configDir, configPath, loadConfig, resolveProfile, saveConfig, setProfileValue };