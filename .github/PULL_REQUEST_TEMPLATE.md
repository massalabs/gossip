<!--
  Thanks for contributing to Gossip! Please take a moment to fill out this template.
  New contributors: the cla-assistant bot will post a comment on this PR with a
  one-click CLA acceptance link — see CONTRIBUTING.md (Section 1) for details.
-->

## Summary

<!-- Briefly describe what this PR changes and why. Link any related issues: -->

Closes #<issue-number>

## CLA

- [ ] I have signed the **Gossip CLA** (Individual `CLA/ICLA.md` or Corporate `CLA/CCLA.md`), or my employer has signed the Corporate CLA and added me to Schedule B. See `CONTRIBUTING.md` § 1.
  - New contributors: the `cla-assistant` bot will post a link on this PR; sign once and all your future PRs are covered.

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Refactor / chore / docs (no user-facing change)
- [ ] Security-relevant (please also email `dv@massa.net` if you have not already)

## Component(s) affected

<!-- Check all that apply. Remove anything not relevant. -->

- [ ] Web app (`src/`)
- [ ] `@massalabs/gossip-sdk` (`gossip-sdk/`)
- [ ] Rust / WASM (`wasm/`)
- [ ] iOS (`ios/`)
- [ ] Android (`android/`)
- [ ] Tooling / CI / build (`scripts/`, `.github/workflows/`, build configs)
- [ ] Documentation (`README.md`, `CONTRIBUTING.md`, `CLA/`, etc.)

## Verification

<!-- What did you run to verify your change? Linters, tests, build, manual steps. -->

- [ ] `npm run fmt:check`
- [ ] `npm run lint`
- [ ] `npm run test:run`
- [ ] `npm run build:sdk` (if `gossip-sdk/` or `wasm/` was touched)
- [ ] `cargo fmt --manifest-path wasm/Cargo.toml` (if `wasm/` was touched)
- [ ] `cargo clippy --manifest-path wasm/Cargo.toml` (if `wasm/` was touched)
- [ ] Tested manually (describe below)

### Manual test notes

<!-- If applicable: platform(s) tested (web/iOS/Android), scenarios, observations, screenshots. -->

## Breaking changes

<!-- If this is a breaking change, describe what breaks and what consumers must do.
     For SDK / public API changes, include a migration note. -->

## Additional notes

<!-- Anything else reviewers should know: performance implications, follow-up work,
     dependency updates, etc. Remove this section if empty. -->

## Screenshots / recordings

<!-- For UI changes only. Remove this section if not applicable. -->
