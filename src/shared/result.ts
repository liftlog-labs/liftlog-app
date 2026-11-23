export type ErrorCode =
  | "INVALID_INPUT"
  | "NAME_TAKEN"
  | "LIVE_WORKOUT_EXISTS"
  | "NOT_FOUND"
  | "ACTION_CONFLICT"
  | "INVALID_BACKUP"
  | "UNSUPPORTED_FORMAT"
  | "STORAGE_FAILURE"
  | "UNAVAILABLE"
  | "NETWORK_ERROR"
  | "SERVICE_ERROR"
  | "STALE"
  | "CONSENT_REQUIRED"
  | "SIGN_IN"
  | "WORKSPACE_MISMATCH";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; fields?: Record<string, string> };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(code: ErrorCode, fields?: Record<string, string>): Result<never> {
  return fields ? { ok: false, code, fields } : { ok: false, code };
}

/** User-safe recovery text; never display transport details or server response bodies. */
export function protectedCallMessage(code: ErrorCode): string {
  switch (code) {
    case "SIGN_IN": return "Sign in from Settings to use this server. Your draft is kept; manual logging is available.";
    case "WORKSPACE_MISMATCH": return "The selected server differs from your sign-in server. Sign in on the selected server in Settings. Your draft is kept.";
    case "CONSENT_REQUIRED": return "Review and allow the current provider permission in Connection settings. Manual logging is available.";
    case "NETWORK_ERROR": return "The server could not be reached. Check your connection and server address. For HTTPS development, confirm the certificate is trusted, then retry. Your draft is kept.";
    case "SERVICE_ERROR": return "The server could not provide valid AI information. Try again or check the server configuration. Your draft is kept.";
    case "INVALID_INPUT": return "Enter a valid server address in Connection settings.";
    case "STALE": return "Your account, context or permission changed. Try again for a fresh response.";
    default: return "This service is unavailable. Try again. Your draft is kept; manual logging is available.";
  }
}
