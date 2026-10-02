import { describe, expect, it } from "vitest";
import { AdmobctlError, diagnoseApiError, LOGIN_COMMAND } from "../src/core/errors.js";

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
    expect(e.fix).toContain(LOGIN_COMMAND);
    expect(e.fix).toContain("admob.readonly");
  });

  it("detects a disabled API and names the project to enable it in", () => {
    const e = diagnoseApiError(403, disabledBody);
    expect(e.code).toBe("API_NOT_ENABLED");
    expect(e.fix).toBe("gcloud services enable admob.googleapis.com --project my-project");
  });

  it("detects a missing quota project before treating it as a disabled API", () => {
    const e = diagnoseApiError(403, quotaBody);
    expect(e.code).toBe("AUTH_QUOTA_PROJECT_MISSING");
    expect(e.fix).toContain("gcloud auth application-default set-quota-project");
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

  it("falls back to a generic error for unknown bodies", () => {
    const e = diagnoseApiError(500, "upstream exploded");
    expect(e).toBeInstanceOf(AdmobctlError);
    expect(e.code).toBe("API_ERROR");
    expect(e.status).toBe(500);
    expect(e.message).toContain("upstream exploded");
  });
});
