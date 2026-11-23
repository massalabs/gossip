# Privacy checks of the build

Gossip is a privacy-first messenger. Privacy comes before debugging and
reporting: a release build writes no log, and the app contacts only the Gossip
backend, mesh peers and a short list of hosts the project owner approved.
`npm run build` enforces this with the checks below. Each one stops the build
with a message that says what it found, why it matters and what to do.

**Never weaken a check or extend one of its lists to make the build pass.**
Find the cause and remove it, or override the library default that brings it.
If something is truly needed, stop and ask the project owner, and change the
list only with their explicit approval.

## The checks

| Script                                                | When               | What it enforces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/audit-logging.mjs source`                    | before the build   | No `console` use (any method, `console[...]`, `console?.[...]`) in app source outside `src/utils/logger.ts` and `src/sw.ts`. No native log call (`Log.`, `println`, `printStackTrace`, `System.out`, `NSLog`, `os_log`, `Logger(`, `print(`, `CAPLog.print`) in the app's own Kotlin, Java and Swift outside `DebugLog` (Android) or `#if DEBUG` (iOS). `VITE_DEBUG_LOGS` is not `true` for a production build. No patch in `patches/` changes certificate or trust handling without a debug-only guard in the same hunk. Capacitor bridge logging is off. |
| `scripts/audit-paths.mjs source`                      | before the build   | The committed wasm bundles hold no home directory path (`/home/`, `/Users/`, `C:\Users\`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `gossip-sdk/scripts/audit-production-worker.mjs dist` | after `vite build` | The production storage worker holds no test fault controls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scripts/audit-logging.mjs dist`                      | after the build    | No `console` use in the bundle, except the i18next default logger, which `src/i18n/index.ts` replaces by a silent one.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `scripts/audit-hosts.mjs dist`                        | after the build    | Every host named by a URL in `dist/**/*.{js,mjs,html,json,webmanifest}` is in `scripts/allowed-hosts.ts`, or is the host of the build's `VITE_GOSSIP_API_URL`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `scripts/audit-paths.mjs dist`                        | after the build    | No file of `dist/` holds a home directory path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

| `scripts/audit-full-debug.mjs dist` | after the build | No file of `dist/` holds code of the full debug build: the upload path `/debug-logs`, the `DebugLogFile` plugin, its storage keys, its overlay, the label of its encryption (`gossip-debug-logs v1`), or the value of `VITE_DEBUG_LOGS_PUBLIC_KEY` when the environment holds one, and no `.wasm` file holds the group engine's debug event names (`engine.event.in`, `engine.retrieval.ask`: a bundle built with the cargo feature `full-debug`). `scripts/audit-logging.mjs source` also fails when `VITE_FULL_DEBUG` is `true`. `npm run build:full-debug` runs it with `--expect-debug-wasm`, which fails when the full debug app lacks those names. |

Their unit tests are in `test/scripts/`.

## The full debug build

A separate app for testers on fresh accounts (`npm run build:full-debug`,
`npm run android:full-debug`). It breaks the rules above on purpose: it
records everything the app does, message content and keys included, in
`filesDir/debug-logs/` (Android; memory only on the web), and sends the record
to `<origin of VITE_GOSSIP_API_URL>/debug-logs/` with the secret
`VITE_DEBUG_LOGS_UPLOAD_SECRET`. What keeps it out of a release:

- One flag: `VITE_FULL_DEBUG=true` (web) and `-PfullDebug=true` (Gradle). All
  its JS is in `src/fullDebug/`, reached only through `FULL_DEBUG`
  (`src/config/fullDebug.ts`), a constant the bundler folds, so a normal
  bundle drops it; `scripts/audit-full-debug.mjs` checks that it did. All its
  native code is in `android/app/src/fulldebug/`, compiled only with the
  Gradle flag; `DebugLog` and `MainActivity` reach it behind
  `BuildConfig.FULL_DEBUG`, a compile-time false elsewhere.
- The group engine (`wasm/groups`) logs its decisions (the verdict on each
  received event, retrieval, membership changes, tip sync) only when built with
  the cargo feature `full-debug`; without it the log macros expand to nothing
  and the normal wasm bundle has the same code section. `npm run build:full-debug`
  builds that bundle into `gossip-sdk/src/assets/generated/wasm-full-debug/`
  (never committed) and Vite uses it in place of the committed one; the SDK
  forwards its events to the debug log only when the bundle has
  `GroupsNode.set_debug_sink`. The committed bundle stays the normal build's
  (the generated-files check of `rust-wasm.yml`).
- A separate app: `net.massa.gossip.debug`, named "Gossip DEBUG", red icon. It
  installs beside the real app and cannot replace it.
- Gradle refuses a release or bundle task with `-PfullDebug=true`, and
  `npm run build` refuses `VITE_FULL_DEBUG=true`.
- A warning banner that cannot be dismissed on the login, onboarding and
  settings screens.
- The upload host is the backend's own host, already allowed: the allowed
  hosts list is unchanged.
- Every send is encrypted to the developers' public key (next section): the
  backend, and anyone holding its read secret, stores and sees only
  ciphertext.

### Encryption of the sends (GDL1)

The log (one gzip stream) and every attached file are each encrypted, on the
phone, to a P-256 public key whose private half only the developers hold. The
key is built in from `VITE_DEBUG_LOGS_PUBLIC_KEY` (base64 of the DER
SubjectPublicKeyInfo, i.e. the PEM body on one line; in CI the repository
variable `DEBUG_LOGS_PUBLIC_KEY`). A full debug build without a valid key
fails (`vite.config.ts`, and the CI step before it), and a send without a
valid key fails with a message: there is no plaintext fallback. "Share the
file instead" shares the same encrypted file
(`gossip-debug-log-<install>-<time>.gdl1`).

| Part   | Bytes                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| header | `GDL1` (4), ephemeral P-256 public key uncompressed `04‖X‖Y` (65), nonce prefix (4)                                                                                                                                           |
| key    | HKDF-SHA256, ikm = ECDH x coordinate (32), salt = ephemeral public (65) ‖ recipient public (65), info = `gossip-debug-logs v1`, 32 bytes                                                                                      |
| chunks | the plaintext in 65,536-byte chunks (the last may be shorter, empty only if the whole is). Each: u32 BE length ‖ AES-256-GCM ciphertext ‖ 16-byte tag; nonce = prefix ‖ u64 BE index; AAD = `01` for the last, `00` otherwise |

A fresh ephemeral key and nonce prefix for every file of every send; the
ephemeral private key is never stored or logged. A reader that reaches the end
without a chunk marked last fails, so a truncated file is detected. The
backend is unchanged: its SHA-256 check is over the ciphertext it receives.

Nothing the tester types or picks travels readable (`src/fullDebug/private.ts`).
The note, the attached files' original names, types and sizes, the user agent
and the SHA-256 of the log's gzip stream go into one small JSON document,
encrypted as its own GDL1 file and sent as the attachment `m0`. The files
travel under the opaque names `a1`, `a2`, … (7 at most: the backend takes 8
attachments, one is `m0`). The `done` call's `meta` keeps only what finds and
decrypts an upload: `enc: "GDL1"`, `keyFp` (hex SHA-256 of the recipient key's
DER: which private key decrypts), app version, commit, platform, the two
options, line range and count, sizes of the log, and the time of the send.

Where: the log natively in `prepareUpload` (`Gdl1.kt`, and `Gdl1` in
`DebugLogFilePlugin.swift`), streamed to the upload file; attachments and the
web log in `src/fullDebug/gdl1.ts` (WebCrypto). Each implementation is checked
against the vectors `test/fixtures/gdl1/vectors.json` (made with TEST-ONLY
keys by `test/fixtures/gdl1/make-vectors.mjs`): JS by
`test/fullDebug/gdl1.node.spec.ts`, Kotlin by `Gdl1Test`
(`./gradlew testDebugUnitTest -PfullDebug=true`), and both native ones again
on the device at every start (record line `enc.selftest`).

Decrypt a download (`scripts/debug-logs-decrypt.mjs`, Node only, no
dependency; it is also the reference implementation):

```sh
# the private key from a file, from DEBUG_LOGS_PRIVATE_KEY, or from stdin
node scripts/debug-logs-decrypt.mjs --gunzip --key-file private.pem log.gz log.jsonl
node scripts/debug-logs-decrypt.mjs att-a1 a1.bin < private.pem
# a whole downloaded upload: log.jsonl, m0.json, and the files under their
# original names (read from m0, sanitised, kept inside the directory)
node scripts/debug-logs-decrypt.mjs --key-file private.pem --upload-dir <install>/<upload>
```

It prints the `keyFp` of the key it was given, writes `<out>.part` and renames
it only when every chunk authenticates and the last one is seen; otherwise it
deletes the partial output and exits with status 1.

## Native code

- Android: the app logs through `net.massa.gossip.DebugLog`, which writes only
  when `BuildConfig.DEBUG`. The background runner plugin is patched
  (`patches/@capacitor+background-runner+3.0.0.patch`) to log only when the app
  is debuggable.
- iOS: every log line of the app and the share extension is inside
  `#if DEBUG ... #endif`.
- Rust: every build of a library the app ships passes `--remap-path-prefix`
  through `scripts/rust-remap-flags.sh`, so no build path reaches the app. A new
  Rust build must pass the same `--config`. The mesh crates compile their
  `tracing` statements out of release builds (`release_max_level_off`, through
  their default feature `quiet-release`). Only the full debug app
  (`-PfullDebug=true`) builds gossip-mobile with `--no-default-features
--features full-debug`, which keeps the lines and sends them to the Android
  log (tag `GossipMesh`). `scripts/build-mesh-android.sh` stops a normal build
  whose library holds the tag `GossipMesh` or the text of a mesh log line, and a
  full-debug build whose library lacks them.

## Adding an allowed host

1. Ask the project owner first. Say which host, what for, what the app sends
   to it, and whether the user starts it with a tap.
2. With their approval, add an entry to `scripts/allowed-hosts.ts`: under
   `ALLOWED_HOSTS` with its kind, its purpose and who approved it, or under
   `KNOWN_INERT_HOSTS` when a library carries it but the app never contacts it,
   with the file that shows why.
3. A page the user opens with a tap is announced before the tap, in simple
   words, with what the website will learn.
