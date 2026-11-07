# Architecture and privacy

- `candidate/littleZen.uc.js`: privileged browser integration, compact-window behavior, Zen routing, search, containers and Space interactions.
- `candidate/little-zen.css`: Little Zen search and page-window styling.
- `candidate/little-zen-bridge.lua`: optional Hammerspoon global shortcut, Zen activation and focus-return coordination.
- `scripts/`: maintenance of an existing setup only.
- `tests/`: focused checks and simulations; no personal profile data is needed.

The bridge and browser use temporary files under `/private/tmp` to associate a global invocation with a focus-return event. In this review candidate, browser diagnostic logging is disabled by default; enabling `extensions.littleZen.enableDebugLog` writes `little-zen-debug.log` to the current Zen profile and may include URLs. The opt-in change is not yet verified in live Zen. Debug details must be reviewed and redacted before sharing. Logs and backups are excluded from the review package.

This code depends on implementation details in Zen and Firefox. OS versions, Zen upgrades, multi-profile setups, private browsing, and external link handlers may behave differently and need real-world verification. The source is derived from the projects credited in the README; distribution permissions are not established in this draft.
