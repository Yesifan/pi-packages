# Changelog

All notable changes to this package are documented here. The format follows Keep a Changelog.

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
