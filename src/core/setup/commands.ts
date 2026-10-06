/** Pin follow-up commands to the profile being diagnosed or configured. */
export function profileCommand(command: string, profile: string, configuredDefault = "default"): string {
  if (profile === "default" && configuredDefault === "default") return command;
  if (/--profile(?:[=\s]|$)/.test(command)) return command;
  const quoted = /^[A-Za-z0-9._-]+$/.test(profile) ? profile : `'${profile.replace(/'/g, "'\\''")}'`;
  return command.replace(/\badmobctl /, () => `admobctl --profile ${quoted} `);
}
