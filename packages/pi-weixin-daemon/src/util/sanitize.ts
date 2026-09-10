/** Strip control characters and anything that could break message fields. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Filenames must not contain ASCII control characters.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  return cleaned;
}

/** Sanitize a directory name (message ids, etc.). */
export function sanitizeDirName(name: string): string {
  const cleaned = sanitizeFilename(name);
  return cleaned || "unknown";
}
