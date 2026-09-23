# Changelog

All notable changes to this package are documented here. The format follows Keep a Changelog.

## [0.2.3] - 2026-09-14

### Added

- Model-visible snapshots of active direct subagents and shared live usage in successful delegation results, busy/limit errors, and automatic reports.

### Changed

- Clarified asynchronous parallel delegation, non-overlapping task ownership, automatic reporting, and interim-only responses while relevant reports remain pending.
- Kept tool descriptions fixed during execution while deriving their configured live-agent limit when each session registers its tools.
- Removed run IDs from model-visible startup and report text while retaining them in structured details and persistent records.

### Fixed

- Corrected the explicit `cwd` parameter description and replaced the incomplete normal-ask and steering result guidance.
- Prevented a tool abort observed after Pi's successful preflight from rolling back an accepted start or reporting accepted steering as failed.

## [0.2.2] - 2026-09-14

### Fixed

- Atomically reserve idle subagents and the shared live-agent budget before asynchronous normal-ask initialization, preventing concurrent `ask_subagent` calls from accepting duplicate or over-limit runs.

## [0.2.1] - 2026-09-11

### Added

- A root-owned native Pi widget showing the latest activity and current-run model call count for each active subagent.

## [0.2.0] - 2026-09-11

### Changed

- **BREAKING:** Moved configuration to `<projectRoot>/.pi/subagents/setting.json`; the former global and project extension config paths are no longer read.
- **BREAKING:** Moved the authoritative root store to `<rootProject>/.pi/subagents/sessions/<rootKey>/` without migrating or falling back to legacy agent-dir data.
- Stored child history as a root-scope-relative path and validate its agent ownership, file identity, and containment before resume.

### Added

- Trust-gated project storage initialization with a local `/sessions/` Git ignore rule.
- Fail-closed checks for tracked or unignored session data, unsafe symlinks, path escapes, missing runtime scopes, and root identity mismatches.
- Private `0600` child Pi session creation and project-local storage requirements/ADR documentation.

## [0.1.0] - 2026-09-11

### Added

- Background `subagent` and persistent `ask_subagent` tools.
- Session-local agent registries and exact external cwd authorization.
- Agent definition snapshots, nested delegation, cycle/depth/live limits, automatic reports, and steering.
- File-backed logical metadata, child Pi session history, and root writer locking.
- Shared FIFO proxy for supported Pi UI capabilities.
- Domain model documentation covering identities, ownership, run semantics, lifecycle, and persistence.
