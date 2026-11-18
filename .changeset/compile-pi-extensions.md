---
"@yesifan/pi-session": minor
"@yesifan/pi-subagents": minor
"@yesifan/pi-system-prompt": minor
---

BREAKING: Pi loads each extension from the package-root `index.js`, which delegates to compiled JavaScript in `dist/`. If your configuration references or filters an old entry (`src/index.ts`, `dist/index.js`, or `extensions/`), change it to `index.js` relative to that package. Package-name and package-directory installs pick up the new entry automatically.
