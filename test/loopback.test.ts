import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

// A loopback server that cannot listen (as in a sandbox that forbids it).
vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  createServer: () => {
    const server = Object.assign(new EventEmitter(), {
      listen: () => {
        queueMicrotask(() => server.emit("error", Object.assign(new Error("listen EPERM: operation not permitted 127.0.0.1"), { code: "EPERM" })));
        return server;
      },
      close: () => server,
      address: () => null,
    });
    return server;
  },
}));

const { waitForLoopbackCode } = await import("../src/core/auth/oauth.js");
const { login } = await import("../src/core/auth/login.js");

afterEach(() => void vi.useRealTimers());

it("a listen error rejects the sign-in at once, as an AdmobctlError, and stops the timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const wait = waitForLoopbackCode({ state: "s" });
  await expect(wait.ready).rejects.toMatchObject({ name: "AdmobctlError", code: "AUTH_NO_CREDENTIALS", message: expect.stringContaining("EPERM") });
  await expect(wait.code).rejects.toMatchObject({ code: "AUTH_NO_CREDENTIALS" });
  expect(vi.getTimerCount()).toBe(0);
});

it("login reports the listen error instead of leaving a rejection unhandled", async () => {
  const opened: string[] = [];
  const err = await login({
    configDir: "/nonexistent",
    profile: "default",
    clientId: "cid",
    store: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    openBrowser: async (url) => void opened.push(url),
    print: () => {},
  }).catch((e: unknown) => e);
  expect(err).toMatchObject({ code: "AUTH_NO_CREDENTIALS" });
  expect(opened).toEqual([]);
});
