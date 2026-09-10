const DEFAULT_FALLBACK = "未知错误，请稍后重试";
const DEFAULT_MAX_LENGTH = 800;

/** Convert an internal error into bounded, single-line, best-effort redacted user text. */
export function formatUserFacingError(
  error: unknown,
  options: { fallback?: string; maxLength?: number } = {},
): string {
  const fallback = options.fallback ?? DEFAULT_FALLBACK;
  const maxLength = Math.max(1, options.maxLength ?? DEFAULT_MAX_LENGTH);
  let text = error instanceof Error ? error.message : String(error ?? "");

  text = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .replace(/\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token)(\s*[:=]\s*)[^\s&,;]+/gi, "$1$2[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text === "undefined" || text === "null") text = fallback;
  if (text.length > maxLength) text = `${text.slice(0, Math.max(1, maxLength - 1))}…`;
  return text;
}
