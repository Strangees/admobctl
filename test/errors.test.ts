import { describe, expect, it } from "vitest";
import { AdmobctlError, diagnoseApiError } from "../src/core/errors.js";

// Error bodies follow the documented google.rpc.Status JSON shape.
const scopeBody = {
  error: {
    code: 403,
    message: "Request had insufficient authentication scopes.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        domain: "googleapis.com",
        metadata: { service: "admob.googleapis.com", method: "x" },
      },
    ],
  },
};

const disabledBody = {
  error: {
    code: 403,
    message:
      "AdMob API has not been used in project my-project before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/admob.googleapis.com/overview?project=my-project then retry.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        domain: "googleapis.com",
        metadata: { consumer: "projects/my-project", service: "admob.googleapis.com" },
      },
    ],
  },
};

const quotaBody = {
  error: {
    code: 403,
    message:
      "Your application is authenticating by using local Application Default Credentials. The admob.googleapis.com API requires a quota project, which is not set by default.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        domain: "googleapis.com",
        metadata: { consumer: "projects/764086051850", service: "admob.googleapis.com" },
      },
    ],
  },
};

const expiredBody = {
  error: {
    code: 401,
    message: "Request had invalid authentication credentials. Expected OAuth 2 access token.",
    status: "UNAUTHENTICATED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_EXPIRED",
        domain: "googleapis.com",
      },
    ],
  },
};

describe("diagnoseApiError", () => {
  it("detects a missing AdMob scope and gives the login command", () => {
    const e = diagnoseApiError(403, scopeBody);
    expect(e.code).toBe("AUTH_SCOPE_MISSING");
    expect(e.fix).toBe("admobctl setup login --yes");
  });

  it("detects a disabled API and names the project to enable it in", () => {
    const e = diagnoseApiError(403, disabledBody);
    expect(e.code).toBe("API_NOT_ENABLED");
    expect(e.fix).toBe("admobctl setup apis --project my-project --yes");
  });

  it("targets the consumer project from ErrorInfo even when it differs from the quota project", () => {
    const e = diagnoseApiError(403, {
      error: {
        code: 403,
        message: "AdSense Management API has not been used in project consumer-project before or it is disabled.",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            metadata: { consumer: "projects/consumer-project", service: "adsense.googleapis.com" },
          },
        ],
      },
    });
    expect(e.fix).toBe("admobctl setup apis --features payments --project consumer-project --yes");
  });

  it("names the disabled service from ErrorInfo metadata", () => {
    const e = diagnoseApiError(403, {
      error: {
        code: 403,
        message: "AdSense Management API has not been used in project my-project before or it is disabled.",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            metadata: { consumer: "projects/my-project", service: "adsense.googleapis.com", serviceTitle: "AdSense Management API" },
          },
        ],
      },
    });
    expect(e.code).toBe("API_NOT_ENABLED");
    expect(e.message).toBe("The AdSense Management API is not enabled in project my-project.");
    expect(e.fix).toBe("admobctl setup apis --features payments --project my-project --yes");
  });

  it("detects a missing quota project before treating it as a disabled API", () => {
    const e = diagnoseApiError(403, quotaBody);
    expect(e.code).toBe("AUTH_QUOTA_PROJECT_MISSING");
    expect(e.fix).toBe("admobctl setup project list");
  });

  it("detects expired credentials", () => {
    const e = diagnoseApiError(401, expiredBody);
    expect(e.code).toBe("AUTH_TOKEN_EXPIRED");
    expect(e.fix).toContain("login");
  });

  it("maps 404 to NOT_FOUND and keeps Google's message", () => {
    const e = diagnoseApiError(404, { error: { code: 404, message: "Account not found", status: "NOT_FOUND" } });
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("Account not found");
  });

  it("keeps the generic rate-limit fix when no Retry-After hint is given", () => {
    const e = diagnoseApiError(429, { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } });
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.message).toContain("Quota exceeded");
    expect(e.fix).toBe("Wait a minute and retry, or narrow the report.");
  });

  it("tells the user how long to wait when the 429 carried a Retry-After", () => {
    const body = { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } };
    const e = diagnoseApiError(429, body, { retryAfterMs: 3_600_000 });
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.message).toBe("Rate limited by the AdMob API: Quota exceeded");
    expect(e.fix).toMatch(/about 1 hour\b/);
    expect(e.fix).not.toMatch(/a minute/);
  });

  it("formats the Retry-After wait in human-friendly units", () => {
    const fix = (ms: number) => diagnoseApiError(429, {}, { retryAfterMs: ms }).fix;
    expect(fix(7_000)).toMatch(/about 7 seconds\b/);
    expect(fix(90_000)).toMatch(/about 90 seconds\b/);
    expect(fix(0)).toMatch(/about 1 second\b/);
    expect(fix(300_000)).toMatch(/about 5 minutes\b/);
    expect(fix(3_599_400)).toMatch(/about 1 hour\b/); // rounds up to a whole hour
    expect(fix(5_400_000)).toMatch(/about 90 minutes\b/);
    expect(fix(7_200_000)).toMatch(/about 2 hours\b/);
    expect(fix(86_400_000)).toMatch(/about 24 hours\b/);
  });

  it("falls back to a generic error for unknown bodies", () => {
    const e = diagnoseApiError(500, "upstream exploded");
    expect(e).toBeInstanceOf(AdmobctlError);
    expect(e.code).toBe("API_ERROR");
    expect(e.status).toBe(500);
    expect(e.message).toContain("upstream exploded");
  });
});
