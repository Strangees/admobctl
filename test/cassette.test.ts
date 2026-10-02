import { describe, expect, it } from "vitest";
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
});
