/**
 * Record/replay of real AdMob API traffic for golden tests.
 * Cassettes hold only URL, method, request body and response; never headers or tokens.
 * Recorded cassettes live in test/fixtures/private/ (gitignored).
 */

export interface CassetteEntry {
  method: string;
  url: string;
  body?: string;
  status: number;
  response: unknown;
}

export interface Cassette {
  recordedAt: string;
  entries: CassetteEntry[];
}

function key(method: string, url: string, body?: string): string {
  return `${method.toUpperCase()} ${url} ${body ?? ""}`;
}

export function recordingFetch(upstream: typeof fetch) {
  const entries: CassetteEntry[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const res = await upstream(input, init);
    const text = await res.clone().text();
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const entry: CassetteEntry = { method: (init.method ?? "GET").toUpperCase(), url: String(input), status: res.status, response };
    if (typeof init.body === "string") entry.body = init.body;
    entries.push(entry);
    return res;
  };
  return {
    fetch: fn as typeof fetch,
    cassette: (): Cassette => ({ recordedAt: new Date().toISOString(), entries }),
  };
}

export function replayFetch(cassette: Cassette): typeof fetch {
  const byKey = new Map(cassette.entries.map((e) => [key(e.method, e.url, e.body), e]));
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    const e = byKey.get(key(init.method ?? "GET", String(input), body));
    if (!e) throw new Error(`Request not in cassette: ${init.method ?? "GET"} ${String(input)}`);
    return new Response(typeof e.response === "string" ? e.response : JSON.stringify(e.response), {
      status: e.status,
      headers: { "content-type": "application/json" },
    });
  };
  return fn as typeof fetch;
}
