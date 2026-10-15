import { spawn } from "node:child_process";

//#region src/core/exec.ts
/** Spawn without a shell. Rejects only if the binary cannot be started. */
const exec = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
	const child = spawn(cmd, args, {
		stdio: opts.interactive ? [
			"inherit",
			2,
			"inherit"
		] : [
			"pipe",
			"pipe",
			"pipe"
		],
		shell: false,
		env: opts.env ?? process.env
	});
	let stdout = "";
	let stderr = "";
	const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : void 0;
	child.stdout?.on("data", (d) => stdout += d);
	child.stderr?.on("data", (d) => stderr += d);
	child.on("error", (err) => {
		if (timer) clearTimeout(timer);
		reject(err);
	});
	child.on("close", (code) => {
		if (timer) clearTimeout(timer);
		resolve({
			code: code ?? 1,
			stdout,
			stderr
		});
	});
	child.stdin?.end(opts.input ?? "");
});

//#endregion
export { exec };