# @yesifan/pi-session

## 0.2.0

### Minor Changes

- 36e1eb8: BREAKING: Pi loads each extension from the package-root `index.js`, which delegates to compiled JavaScript in `dist/`. If your configuration references or filters an old entry (`src/index.ts`, `dist/index.js`, or `extensions/`), change it to `index.js` relative to that package. Package-name and package-directory installs pick up the new entry automatically.
- 86e8991: BREAKING: Merge session discovery into native `@` completion, limit discovery and reference resolution to the current and authorized external directories, and replace `@s:` / `@as:` references with `@session[title](full-ID)`.

### Patch Changes

- a4b8daf: Recheck reopened session targets, wait for outstanding SDK calls during shutdown, and describe incomplete results without reusing older responses.
- a511171: Update the workspace Pi SDK and the daemon's embedded Pi runtime to 1.5.2.

## 0.1.1

### Patch Changes

- cb42bca: Enable session tools in TUI, RPC, JSON and print modes, expand interactive/RPC references independently of UI availability, and make autocomplete/notification failures non-blocking. Clarify asynchronous acceptance, steering, follow-up and caller/nested lifecycle limits without changing task execution semantics.
- ed57cb9: Add session reference completion, authorized history search, and lightweight background conversations with existing sessions.
