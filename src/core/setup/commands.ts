/** One argument for a POSIX shell: as is when it is plainly safe, else single-quoted. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9._\/=,:@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Pin follow-up commands to the profile being diagnosed or configured. */
export function profileCommand(command: string, profile: string, configuredDefault = "default"): string {
  if (profile === "default" && configuredDefault === "default") return command;
  if (/--profile(?:[=\s]|$)/.test(command)) return command;
  return command.replace(/\badmobctl /, () => `admobctl --profile ${shellQuote(profile)} `);
}
