/**
 * Record/replay of real AdMob API traffic for golden tests.
 * Cassettes hold only URL, method, request body and response; never headers or tokens. Requests to Google's OAuth
 * endpoints (token refresh, tokeninfo) pass through unrecorded: their bodies and responses are credentials.
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

/** Google's OAuth token and tokeninfo endpoints. */
function isAuthEndpoint(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.hostname === "oauth2.googleapis.com" || u.hostname === "accounts.google.com" || (u.hostname === "www.googleapis.com" && u.pathname.startsWith("/oauth2/"));
}

export function recordingFetch(upstream: typeof fetch) {
  const entries: CassetteEntry[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const res = await upstream(input, init);
    // A Request carries its own URL and method; String() of one is "[object Request]".
    const url = input instanceof Request ? input.url : String(input);
    if (isAuthEndpoint(url)) return res;
    const text = await res.clone().text();
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const entry: CassetteEntry = { method: method.toUpperCase(), url, status: res.status, response };
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
