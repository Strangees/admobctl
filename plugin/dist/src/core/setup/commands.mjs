//#region src/core/setup/commands.ts
/** Pin follow-up commands to the profile being diagnosed or configured. */
function profileCommand(command, profile, configuredDefault = "default") {
	if (profile === "default" && configuredDefault === "default") return command;
	if (/--profile(?:[=\s]|$)/.test(command)) return command;
	const quoted = /^[A-Za-z0-9._-]+$/.test(profile) ? profile : `'${profile.replace(/'/g, "'\\''")}'`;
	return command.replace(/\badmobctl /, () => `admobctl --profile ${quoted} `);
}

//#endregion
export { profileCommand };