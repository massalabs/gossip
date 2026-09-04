<!--
Thank you for contributing to Gossip. Complete the relevant sections below.
See CONTRIBUTING.md for the contribution process and CLA requirements.
-->

## Summary

<!-- Explain what changed and why. Link related issues. -->

Closes #

## Contributor License Agreement

- [ ] I have accepted the Gossip ICLA, or I am a non-human account expressly
      allowed by the maintainers.
- [ ] If an employer owns or controls rights in my Contribution, the employer
      has authorized all required grants, waived or transferred those rights, or
      provided CCLA coverage.
- [ ] Every identifiable human author or co-author of contributed material on
      this pull request has completed the applicable CLA process.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and the
[Contributor Privacy Notice](../CLA/PRIVACY.md) for details.

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Refactor, maintenance, or documentation
- [ ] Security-relevant change

## Components

<!-- Check all that apply. -->

- [ ] Web application (`src/`)
- [ ] SDK (`gossip-sdk/`)
- [ ] Rust or WASM (`wasm/`)
- [ ] iOS (`ios/`)
- [ ] Android (`android/`)
- [ ] Tooling, CI, or build configuration
- [ ] Documentation or legal files

## Verification

<!-- Check commands that were run and describe equivalent checks if needed. -->

- [ ] `npm run fmt:check`
- [ ] `npm run lint`
- [ ] `npm run test:run`
- [ ] `npm run build:sdk` when SDK or WASM files changed
- [ ] `cargo fmt --manifest-path wasm/Cargo.toml --all -- --check` when Rust changed
- [ ] `cargo clippy --manifest-path wasm/Cargo.toml --workspace --all-targets` when Rust changed
- [ ] `cargo test --manifest-path wasm/Cargo.toml --workspace --all-targets` when Rust changed
- [ ] Manual testing described below

### Manual Test Notes

<!-- Include platforms, scenarios, observations, and screenshots where useful. -->

## Breaking Changes

<!-- Describe affected users and migration steps, or write "None." -->

## Additional Notes

<!-- Include security, performance, deployment, or follow-up considerations. -->
