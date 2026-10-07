import { describe, expect, it } from "vitest";
import { fetchTokenInfo } from "../src/core/auth/doctor.js";
import { OAuthTokenProvider, type SecretStore } from "../src/core/auth/oauth.js";
import { recordingFetch, replayFetch } from "./cassette.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

describe("cassette", () => {
  it("records responses without auth headers and replays them by method, URL and body", async () => {
    const upstream = fakeFetch({
      "GET /v1/accounts?": () => jsonResponse({ account: [{ publisherId: "pub-1" }] }),
      "POST /networkReport:generate": (c) => jsonResponse([{ echo: c.body }]),
    });
    const rec = recordingFetch(upstream.fetch);
    await rec.fetch("https://admob.googleapis.com/v1/accounts?pageSize=1000", { headers: { authorization: "Bearer SECRET" } });
    await rec.fetch("https://admob.googleapis.com/v1/accounts/pub-1/networkReport:generate", {
      method: "POST",
      headers: { authorization: "Bearer SECRET" },
      body: JSON.stringify({ reportSpec: { a: 1 } }),
    });
    const cassette = rec.cassette();
    expect(JSON.stringify(cassette)).not.toContain("SECRET");
    expect(cassette.entries).toHaveLength(2);

    const replay = replayFetch(cassette);
    const r = await replay("https://admob.googleapis.com/v1/accounts/pub-1/networkReport:generate", {
      method: "POST",
      body: JSON.stringify({ reportSpec: { a: 1 } }),
    });
    expect(await r.json()).toEqual([{ echo: { reportSpec: { a: 1 } } }]);
    await expect(replay("https://admob.googleapis.com/v1/other", {})).rejects.toThrow(/not in cassette/);
  });

  it("recognises an OAuth endpoint passed as a Request, and records other Requests by their own URL and method", async () => {
    const upstream = (async () => jsonResponse({ access_token: "ACCESS-TOKEN" })) as unknown as typeof fetch;
    const rec = recordingFetch(upstream);
    await rec.fetch(new Request("https://oauth2.googleapis.com/token", { method: "POST", body: "refresh_token=REFRESH" }));
    expect(JSON.stringify(rec.cassette())).not.toMatch(/ACCESS-TOKEN|REFRESH/);
    await rec.fetch(new Request("https://admob.googleapis.com/v1/accounts", { method: "POST" }));
    expect(rec.cassette().entries.map((e) => `${e.method} ${e.url}`)).toEqual(["POST https://admob.googleapis.com/v1/accounts"]);
  });

  it("never records Google's OAuth endpoints, so refresh tokens, client secrets and access tokens stay out", async () => {
    const upstream = fakeFetch({
      "POST oauth2.googleapis.com/token": () => jsonResponse({ access_token: "ACCESS-TOKEN", expires_in: 3600 }),
      "POST oauth2.googleapis.com/tokeninfo": () => jsonResponse({ scope: "https://www.googleapis.com/auth/admob.readonly", expires_in: "3000" }),
      "GET www.googleapis.com/oauth2/v3/tokeninfo": () => jsonResponse({ scope: "x" }),
      "POST accounts.google.com/o/oauth2/token": () => jsonResponse({ access_token: "ACCESS-TOKEN" }),
      "GET /v1/accounts?": () => jsonResponse({ account: [{ publisherId: "pub-1" }] }),
    });
    const rec = recordingFetch(upstream.fetch);
    const store: SecretStore = {
      get: async () => JSON.stringify({ clientId: "cid.apps.googleusercontent.com", clientSecret: "CLIENT-SECRET", refreshToken: "REFRESH-TOKEN" }),
      set: async () => {},
      delete: async () => {},
    };
    // What record-fixtures did: the OAuth token provider got the recording fetch.
    const token = await new OAuthTokenProvider({ profile: "default", store, fetch: rec.fetch }).getToken();
    await fetchTokenInfo(token, rec.fetch);
    await rec.fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
    await rec.fetch("https://accounts.google.com/o/oauth2/token", { method: "POST", body: "refresh_token=REFRESH-TOKEN&client_secret=CLIENT-SECRET" });
    await rec.fetch("https://admob.googleapis.com/v1/accounts?pageSize=1000", { headers: { authorization: `Bearer ${token}` } });

    const json = JSON.stringify(rec.cassette());
    for (const secret of ["REFRESH-TOKEN", "CLIENT-SECRET", "ACCESS-TOKEN"]) expect(json).not.toContain(secret);
    expect(rec.cassette().entries.map((e) => e.url)).toEqual(["https://admob.googleapis.com/v1/accounts?pageSize=1000"]);
    expect(upstream.calls).toHaveLength(5);
  });
});
