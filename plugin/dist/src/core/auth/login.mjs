import { exec } from "../exec.mjs";
import { loadConfig, saveConfig, setProfileValue } from "../config.mjs";
import { buildAuthUrl, createPkce, exchangeCode, revokeToken, waitForLoopbackCode } from "./oauth.mjs";
import { randomBytes } from "node:crypto";

//#region src/core/auth/login.ts
function systemBrowser(exec$1 = exec) {
	return async (url) => {
		const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
		await exec$1(cmd, args).catch(() => void 0);
	};
}
/** Desktop OAuth (loopback + PKCE). Stores the refresh token in the secret store and switches the profile to oauth. */
async function login(o) {
	const pkce = createPkce();
	const state = randomBytes(16).toString("hex");
	const wait = waitForLoopbackCode({ state });
	const { redirectUri } = await wait.ready;
	const url = buildAuthUrl({
		clientId: o.clientId,
		redirectUri,
		pkce,
		state,
		write: o.write,
		payments: o.payments,
		cloudPlatform: o.cloudPlatform
	});
	o.print(`Opening your browser to sign in to Google. If it does not open, visit:\n\n  ${url}\n\n`);
	await (o.openBrowser ?? systemBrowser())(url);
	const code = await wait.code;
	const t = await exchangeCode({
		clientId: o.clientId,
		clientSecret: o.clientSecret,
		code,
		verifier: pkce.verifier,
		redirectUri
	}, o.fetch);
	const stored = {
		clientId: o.clientId,
		refreshToken: t.refreshToken
	};
	if (o.clientSecret) stored.clientSecret = o.clientSecret;
	await o.store.set(o.profile, JSON.stringify({
		clientId: stored.clientId,
		clientSecret: stored.clientSecret,
		refreshToken: stored.refreshToken
	}));
	const cfg = loadConfig(o.configDir);
	setProfileValue(cfg, o.profile, "oauthClientId", o.clientId);
	setProfileValue(cfg, o.profile, "authMode", "oauth");
	saveConfig(o.configDir, cfg);
	return {
		profile: o.profile,
		scope: t.scope
	};
}
async function logout(o) {
	const raw = await o.store.get(o.profile);
	if (raw) try {
		await revokeToken(JSON.parse(raw).refreshToken, o.fetch);
	} catch {}
	await o.store.delete(o.profile);
	const cfg = loadConfig(o.configDir);
	setProfileValue(cfg, o.profile, "authMode", "auto");
	saveConfig(o.configDir, cfg);
}

//#endregion
export { login, logout, systemBrowser };