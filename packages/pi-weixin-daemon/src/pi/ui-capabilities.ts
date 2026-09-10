/**
 * Capability matrix for the weixin UI context.
 *
 * Explicitly declares which `ExtensionUIContext` primitives are supported over
 * weixin. `custom` is unsupported (its `Promise` resolves to undefined, it never
 * rejects — matching the SDK `noOpUIContext` degrade contract).
 */
export const WEIXIN_UI_CAPABILITIES = {
  confirm: true,
  select: true,
  input: true,
  /** Degraded editor (delegates to the input dialog). */
  editor: true,
  custom: false,
} as const;
