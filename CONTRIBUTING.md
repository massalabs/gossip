# Contributing to Gossip

First of all — thank you for taking the time to contribute to **Gossip**! This
document explains how to get your contribution accepted.

## 1. Sign the Gossip Contributor License Agreement (CLA)

**Before your first pull request can be merged, you must sign the Gossip CLA.**
There are two CLAs; you only need to sign one:

- **Individual CLA (`CLA/ICLA.md`)** — sign this if you are contributing on your
  own behalf (including as an independent contractor submitting your own
  original work), and none of your contributions are subject to an employer's
  rights.
- **Corporate CLA (`CLA/CCLA.md`)** — sign this if your contributions are made
  in the scope of your employment, or would be considered "work made for hire"
  under applicable law, such that your employer (or its client) owns or controls
  the copyright. Your employer (not you) signs the Corporate CLA, and adds you to
  **Schedule B** as an Authorized Employee. Once your employer has signed, you do
  **not** also need to sign the Individual CLA for contributions covered by the
  Corporate CLA.

### How to sign

1. Open your first pull request against `massalabs/gossip` as you normally
   would.
2. The **cla-assistant** bot will automatically post a comment on your PR with
   a one-click acceptance link for the relevant CLA.
3. Click the link and complete the acceptance form. That single signature covers
   all of your present and future contributions to the Project; you do not need
   to re-sign on every PR.
4. Once your signature is recorded, the bot will mark the CLA status as passing
   on your PR (and on all your subsequent PRs).

If you are signing the **Corporate CLA**, the same `cla-assistant` flow applies:
an authorized officer of your company completes the acceptance form, and then
adds the company's Authorized Employees to the list managed by
`cla-assistant.io` (or by submitting a PR that updates
`CLA/CCLA-Schedule-B-<corporation-short-name>.md` per Section 11.2 of the CCLA).

> If you have questions about the CLA or about which one you should sign,
> contact us at info@massa.net.

### Where your signature is stored

Signatures collected via `cla-assistant.io` are stored as a JSON file in the
private [`massalabs/cla`](https://github.com/massalabs/cla) repository. You can
request a copy of, or withdrawal of, your signature at any time by emailing
info@massa.net.

## 2. License of your contributions

By signing the CLA, you grant the Maintainer the rights needed to distribute
your contributions under the **GNU Affero General Public License v3.0 or later**
(`AGPL-3.0-or-later`) — the license under which Gossip is published (see
[`LICENSE`](./LICENSE)) — and, where the Maintainer elects, under one or more
additional or alternative licenses (for example, a commercial license). The
broad grant is paired, per Section 7 of the ICLA / CCLA, with a
**free-software-compatibility promise**: the Maintainer will always keep an
AGPL / FSF-approved version of the Project available to the community.

## 3. Past contributors (retrospective signing)

If you contributed to Gossip before the CLA was introduced, thank you. Your
earlier contributions remain licensed under the AGPL-3.0-or-later terms under
which they were submitted; that does not change. However, to enable the broad
grant (including the patent grant and dual-licensing flexibility) for your
already-merged code, the Maintainer asks that you now sign the CLA
retrospectively using the same `cla-assistant.io` flow described above — your
signature will, by its terms, cover all of your past as well as future
contributions to the Project. If you would rather not, your past contributions
will continue to be governed solely by the AGPL-3.0-or-later inbound license and
nothing in the CLA will alter that.

## 4. Contribution workflow

This section is a quick orientation. For full setup, build, and test
instructions, see the [main `README.md`](./README.md).

### Setup

```bash
git clone https://github.com/massalabs/gossip.git
cd gossip
npm run setup   # installs rust toolchain, wasm tooling, npm deps
npm run dev     # web dev server at http://localhost:5173
```

### Make your change

1. Create a feature branch off `main` (or whatever the current default branch
   is).
2. Make your change. Keep commits focused and use clear commit messages
   (imperative mood — e.g. `fix: handle empty contact list`, `feat(sdk): add
contacts.list()`).
3. Run the linters and tests before you push:

   ```bash
   npm run fmt:check   # `npm run fmt` to auto-format
   npm run lint
   npm run test:run
   npm run build:sdk   # if you touched gossip-sdk/
   ```

### Open a pull request

Open the PR against `main` using the `PULL_REQUEST_TEMPLATE.md` checklist, and
be sure the "I have signed the Gossip CLA" item is checked. New contributors
will see the cla-assistant comment appear within a few moments of opening the
PR.

### Code style

- TypeScript / TSX / JavaScript is enforced by ESLint + Prettier. Configs live
  in `eslint.config.js`, `.prettierrc.json`, and `.prettierignore`.
- Rust (under `wasm/`) follows `rustfmt` defaults. Run
  `cargo fmt --manifest-path wasm/Cargo.toml` and
  `cargo clippy --manifest-path wasm/Cargo.toml` before pushing Rust changes.
- Do **not** add license or copyright header comments to source files; the
  Project relies on the `LICENSE` file at the repo root and per-component
  `LICENSE` files (see `README.md` → "License"). This is consistent with the
  existing codebase, which deliberately omits per-file SPDX headers.

### Commit messages

Follow the short conventional-commits style already in use in the repo:

```
type(scope): short imperative subject

optional body, wrapped at ~72 chars
```

A `Co-authored-by:` trailer is welcome when pairing (and required for
machine-generated content such as Copilot autofixes; see the existing commits
for examples).

## 5. Reporting issues and security

- For bugs and feature requests, open a GitHub issue. Include the platform
  (web / iOS / Android), the Gossip version, and clear reproduction steps.
- For security-sensitive reports, do **not** open a public issue. Email us at
  `dv@massa.net` with a description of the issue and an
  attachment or link to a proof of concept if you have one.

## 6. Code of conduct

Be respectful and constructive in issues, PRs, and review comments. Harassment,
personal attacks, and disruptive behaviour will not be tolerated. We follow the
golden rule: review the code, not the person.

---

_Signatures collected via `cla-assistant.io` are stored in the private
[`massalabs/cla`](https://github.com/massalabs/cla) repository; see § 1 above.
The CLA documents at `CLA/ICLA.md` and `CLA/CCLA.md` contain the authoritative
legal terms; in the event of any inconsistency between this `CONTRIBUTING.md`
and the CLAs, the CLAs control._
