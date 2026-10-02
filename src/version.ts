declare const __ADMOBCTL_VERSION__: string | undefined;

/** Injected at build time by esbuild (and by vitest's define). */
export const VERSION: string = typeof __ADMOBCTL_VERSION__ === "string" ? __ADMOBCTL_VERSION__ : "0.0.0-dev";
