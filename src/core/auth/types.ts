export interface TokenProvider {
  readonly mode: "adc" | "oauth";
  getToken(): Promise<string>;
  /** Discard tokens cached before a new browser sign-in. */
  resetCache?(): void;
  /** Quota project implied by the credentials, if any. */
  quotaProject(): string | undefined;
  /** Throw an actionable AdmobctlError if credentials are missing or unusable. */
  checkCredentials?(): unknown;
}
