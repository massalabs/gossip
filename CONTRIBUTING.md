# Contributing to Gossip

Thank you for contributing to Gossip. This guide explains the legal and
technical steps required for a contribution to be accepted.

## Contributor License Agreements

Every human contributor must accept the
[Individual Contributor License Agreement](./CLA/ICLA.md) (**ICLA**).

If an employer owns or controls rights in a contribution, the employer must also
enter into the [Corporate Contributor License Agreement](./CLA/CCLA.md)
(**CCLA**) and privately designate the individual as a covered contributor. The
CCLA supplements the individual's ICLA; it does not replace it.

An employed contributor may proceed without a CCLA only if the contributor can
truthfully make the ICLA's representations because the employer has specifically
authorized all required grants or has waived or transferred its relevant rights.

Questions about which agreement applies may be sent to `info@massa.net`.

### How to sign

1. Open a pull request against `massalabs/gossip`.
2. Follow the CLA instructions presented on the pull request or contact
   `info@massa.net` if no automated instructions appear.
3. Review the exact agreement version presented for acceptance.
4. Provide the required identity information and make the unambiguous acceptance
   requested by the signing process.
5. Ensure that every identifiable human author or co-author of material in the
   pull request has completed the required ICLA process.

A material CLA revision requires explicit re-acceptance before later
Contributions can be accepted. Acceptance records remain linked to the exact
agreement version or immutable repository revision that was accepted.

For a CCLA, an authorized corporate representative must provide the corporation
and authority information required by Schedule A. Completed CCLAs and
designated-contributor schedules are private records and must not be submitted
in a public pull request.

### Signature records and privacy

MASSA LABS retains CLA records privately. Its designated private repository is
`massalabs/cla`; contributors do not need access to that repository. The exact
signing and storage providers used by the deployed workflow will be identified
through the signing process and the
[Contributor Privacy Notice](./CLA/PRIVACY.md).

The privacy notice explains what data is collected, why it is processed, how
long it is retained, and how to exercise applicable data-protection rights.
Privacy requests may be sent to `info@massa.net`. A privacy request does not
revoke copyright or patent licenses already granted under a CLA.

## License of Contributions

The CLA grants MASSA LABS the rights needed to use and distribute covered
Contributions under the
[GNU Affero General Public License, version 3 or later](./LICENSE)
(`AGPL-3.0-or-later`) and under additional or alternative terms, including
commercial terms.

That broad grant is paired with the open-availability covenant in Section 7 of
each CLA. In summary, while MASSA LABS or a transferee uses or licenses a
Contribution under non-AGPL terms, an identifiable AGPL-3.0-or-later version of
Gossip containing that Contribution must remain publicly available at no charge.
The covenant does not require maintenance, feature parity, publication of
proprietary additions, or inclusion of the Contribution in every later public
version. The applicable CLA controls if this summary and the agreement differ.

Third-party material must be separately and conspicuously identified with its
source and every known license or other restriction, as required by the ICLA and
CCLA. Disclosure alone is insufficient: the submitter must be legally entitled
to make the CLA grants. Material accepted separately under identified written
terms remains outside the CLA.

## Earlier Contributions

An ICLA or CCLA may cover qualifying Contributions submitted before signature,
but only when the signer owns or controls the rights needed to make the grant.
An unsigned retrospective agreement does not bind a contributor.

MASSA LABS may already own rights in work created by its employees or may have
received rights under another agreement or license. The introduction of the CLA
does not revoke or retroactively alter rights already granted for an earlier
release.

## Contribution Workflow

### Set up the project

```bash
git clone https://github.com/massalabs/gossip.git
cd gossip
npm run setup
npm run dev
```

### Make and verify a change

1. Create a focused branch from `dev`.
2. Make the change and add tests where appropriate.
3. Run the relevant checks:

   ```bash
   npm run fmt:check
   npm run lint
   npm run test:run
   npm run build:sdk  # if gossip-sdk/ or generated WASM was touched
   ```

4. For Rust changes, also run:

   ```bash
   cargo fmt --manifest-path wasm/Cargo.toml --all -- --check
   cargo clippy --manifest-path wasm/Cargo.toml --workspace --all-targets
   cargo test --manifest-path wasm/Cargo.toml --workspace --all-targets
   ```

5. Open a pull request against `dev` and complete the pull-request template.

### Generated files

Generated WASM files under `gossip-sdk/src/assets/generated/` are committed SDK
inputs. Regenerate them through the repository scripts; do not edit generated
JavaScript, declarations, package metadata, or binaries manually.

Run the following after a relevant Rust or Cargo metadata change:

```bash
npm run wasm:build
```

### Code style

- TypeScript, TSX, and JavaScript are checked by ESLint and Prettier.
- Rust follows `rustfmt` defaults and must pass Clippy.
- Do not add per-file license or copyright headers. The project uses root and
  component license files plus third-party notices.

### Commit messages and automation

Use the repository's concise conventional-commit style:

```text
type(scope): short imperative subject
```

`Co-authored-by:` trailers may be retained when collaboration or automation
tools add them, but they are not required for machine-assisted work. Regardless
of attribution metadata, the human submitter is responsible for reviewing the
change and confirming that it satisfies the CLA's authorship, authority, and
third-party disclosure requirements.

## Core Development Principles

When modifying Gossip, especially messaging, cryptographic, SDK, or storage-related code, consider these three core principles:

### Encoding and backward compatibility

Changes to wire formats, APIs, SDK interfaces, or persistent storage should preserve backward compatibility whenever possible.
Before changing an existing format or interface, consider how existing clients, applications, and stored data will behave.

### Security

Preserve Gossip's existing security properties, including:

- Post-Quantum Cryptography (PQC)
- Perfect Forward Secrecy (PFS)
- Post-Compromise Security (PCS)
- Plausible deniability
- Encryption at rest
- Message authentication and integrity

Do not introduce new plaintext representations of data that was previously protected by encryption, or bypass existing cryptographic protections.

### Usability and maintainability

Verify the complete user flow, including edge cases and compatibility with existing behavior.
Prefer the smallest implementation that correctly satisfies the requirement. Reuse existing code where appropriate and avoid unnecessary duplication, refactoring, or complexity.
Before considering a message-related change complete, explicitly evaluate **encoding / backward compatibility, security, and usability**.

## Bugs and Security Reports

Use GitHub issues for ordinary bugs and feature requests. Include the affected
platform, Gossip version, and clear reproduction steps.

Do not disclose a suspected vulnerability in a public issue. Send security
reports to `dv@massa.net`, including a description and a proof of concept when
available.

## Conduct

Be respectful and constructive in issues, pull requests, and reviews. Focus
criticism on the work rather than the person. Harassment, personal attacks, and
disruptive behavior are not accepted.

The [ICLA](./CLA/ICLA.md) and [CCLA](./CLA/CCLA.md) contain the authoritative
legal terms. If this guide conflicts with an applicable CLA, the CLA controls.
