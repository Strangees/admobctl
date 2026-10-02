import { readFileSync } from "node:fs";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/api/${name}`, import.meta.url), "utf8")) as T;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * A fake fetch that answers from a list of route handlers and records every call.
 * Routes are matched by "METHOD path-substring".
 */
export function fakeFetch(routes: Record<string, (call: RecordedCall) => Response | Promise<Response>>) {
  const calls: RecordedCall[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { url, method, headers, body };
    calls.push(call);
    const key = Object.keys(routes)
      .filter((k) => {
        const [m, path] = k.split(" ", 2) as [string, string];
        return m === method && url.includes(path);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`fakeFetch: no route for ${method} ${url}`);
    return routes[key]!(call);
  };
  return { fetch: fn as typeof fetch, calls };
}

export const noSleep = async () => {};

type Dims = Record<string, [value: string, label?: string]>;
type Metrics = Record<string, number>;
const MONEY = new Set(["ESTIMATED_EARNINGS", "OBSERVED_ECPM"]);

/** A synthetic streamed report: header, rows, footer. */
export function synthReport(rows: Array<[Dims, Metrics]>, currency = "NOK") {
  return [
    { header: { localizationSettings: { currencyCode: currency }, reportingTimeZone: "Europe/Oslo" } },
    ...rows.map(([dims, metrics]) => ({
      row: {
        dimensionValues: Object.fromEntries(
          Object.entries(dims).map(([k, [value, displayLabel]]) => [k, displayLabel === undefined ? { value } : { value, displayLabel }]),
        ),
        metricValues: Object.fromEntries(
          Object.entries(metrics).map(([k, v]) => [k, MONEY.has(k) ? { microsValue: String(v) } : { integerValue: String(v) }]),
        ),
      },
    })),
    { footer: { matchingRowCount: String(rows.length) } },
  ];
}
