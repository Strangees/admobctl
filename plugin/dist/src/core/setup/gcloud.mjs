import { AdmobctlError } from "../errors.mjs";

//#region src/core/setup/gcloud.ts
/** The only gcloud call setup makes: creating Application Default Credentials needs gcloud and a browser. */
function loginArgs(scopes) {
	return [
		"auth",
		"application-default",
		"login",
		`--scopes=${scopes.join(",")}`
	];
}
function loginCommand(scopes) {
	return `gcloud ${loginArgs(scopes).join(" ")}`;
}
const GCLOUD_INSTALL_URL = "https://cloud.google.com/sdk/docs/install";
async function gcloudInstalled(exec) {
	try {
		return (await exec("gcloud", ["--version"], { timeoutMs: 3e4 })).code === 0;
	} catch {
		return false;
	}
}
/** Runs the sign-in attached to this terminal, so gcloud can open the browser and print its prompts (on stderr). */
async function runLogin(exec, scopes) {
	const r = await exec("gcloud", loginArgs(scopes), { interactive: true });
	if (r.code !== 0) throw new AdmobctlError("AUTH_NO_CREDENTIALS", `The gcloud sign-in did not complete (exit code ${r.code}).`, { fix: "admobctl setup login --yes" });
}

//#endregion
export { GCLOUD_INSTALL_URL, gcloudInstalled, loginArgs, loginCommand, runLogin };