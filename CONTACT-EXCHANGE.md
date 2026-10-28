# In-person contact exchange

Adding someone who stands next to you works with no internet and without
publishing keys anywhere. The person to add shows an **animated QR code** that
carries their public keys; the other phone reads it with the camera. As soon as
the camera has read one frame, the phones can also do the exchange over
**Bluetooth**, which is faster and still works when the camera struggles.
Whichever path finishes first wins. In both cases the keys are checked against
the user id (the user id is the BLAKE3 hash of the keys) before the contact is
added, through the usual add-contact form, with no server lookup.

The plain invite QR code and link stay for sharing at a distance, and are the
only option on the web.

## User flow

- **Share contact → In person** (the default on Android and iOS): the animated
  code, "Hold your phone in front of their camera", a Bluetooth line, and
  **Show a simple code**, a single small frame for cameras that cannot follow the
  animation (it needs Bluetooth on both phones).
- Bluetooth is used on the showing phone only if it is already allowed;
  otherwise **Use Bluetooth too** asks for it. Choosing the simple code asks for
  it too. Without Bluetooth the animated code works on its own.
- **Scan** (new contact or share page): the camera stays open and shows
  "Reading their code… 40%". After one frame, if Bluetooth is allowed, the
  scanning phone also connects ("Using Bluetooth…"). For a simple code with
  Bluetooth not allowed, the camera closes and the app asks for it. Plain invite
  codes are read as before.
- The add-contact form then opens with the user id, the name if shared, and the
  keys, so **Add** needs no internet.

Code: `src/utils/contactExchange/` (format, crypto, checks),
`src/services/contactExchange.ts` (sessions, plugin),
`src/components/settings/InPersonContactCode.tsx` and `ScanQRCode.tsx` (UI),
`src/components/qr/AnimatedQRCode.tsx`; native plugins `ContactExchange`
(Android `net.massa.gossip.exchange`, iOS `plugins/contactExchange`) and the
continuous mode of `QrScanner`.

## QR frames

Each frame is a QR code in alphanumeric mode, error correction L:

```text
header only:  UR:GOSSIP-CONTACT/<header>
fountain:     UR:GOSSIP-CONTACT/<header>/<seq>-<count>/<fragment>
```

- `<header>` is the minimal bytewords (with their CRC32) of the CBOR byte
  string of the 73 header bytes:

  | Bytes | Field                                         |
  | ----- | --------------------------------------------- |
  | 1     | version, `0x01`                               |
  | 32    | user id                                       |
  | 32    | presenter's ephemeral X25519 public key (`A`) |
  | 8     | random rendezvous id                          |

  Every frame carries it, so a single frame is enough to start Bluetooth.

- `<seq>-<count>/<fragment>` is a standard BC-UR multipart part (BCR-2020-005)
  of the UR whose CBOR is the byte string of the **payload**: removing the
  header path component gives `ur:gossip-contact/<seq>-<count>/<fragment>`,
  which any BC-UR decoder reads. Parts 1…count are the plain fragments; later
  ones are fountain mixes, so frames can be read in any order, with gaps.

- The payload is `header (73) ‖ name length (u16 BE) ‖ name (UTF-8, ≤ 400
bytes) ‖ public keys` (`UserPublicKeys` bytes, 3046 today). The header inside
  it binds the keys to the code; frames of another code are ignored.

Sizes: fragments of at most 200 bytes, so 16 fragments and about 610 characters
per frame, a version 13 QR code (69 modules). The code shows the 16 plain parts
then 16 mixed ones, in a loop, 150 ms per frame (a loop takes 4.8 s). Phone
cameras give 30 frames a second and ZXing on Android decodes a 1080p frame in
30–80 ms, so each QR frame gets two or more decode attempts; a reader that
misses frames completes on mixed parts or on the next loop. The simple code is
the header-only frame: 176 characters, version 6.

The fountain coding is the BC-UR reference algorithm (Xoshiro256\*\* seeded by
SHA-256 of `seqNum ‖ checksum`, alias-method degree, shuffle), in
`utils/contactExchange/bcur.ts`. The npm implementation (`@ngraveio/bc-ur`,
MIT) depends on Node's `Buffer`, `assert` and `process`; it is a dev dependency
only, and tests check that both give byte-identical parts and read each other's.
The decoder accepts at most 128 parts and 16 KiB messages.

## Bluetooth exchange

Separate from the mesh node and not stored in it: its own GATT server and
advertising set on Android, its own peripheral and central managers on iOS.

**Rendezvous.** From the rendezvous id `r`:
`service UUID = BLAKE3-derive-key("gossip-contact-exchange/1 service", r)[0..16]`
and `characteristic UUID` the same with `characteristic`. The presenter
advertises only that service UUID (no name, no Gossip identifier), connectable,
while the code is on screen. The UUIDs look random and change with every code.

**GATT.** One primary service, one characteristic: write (with response) and
notify, with its CCCD.

**Messages.** The scanner scans for the service UUID, connects, asks for an ATT
MTU of 517, subscribes, then writes one request:

```text
request  = 0x01 ‖ B                                  (33 bytes, B = scanner's ephemeral X25519 key)
response = 0x01 ‖ nonce (24) ‖ XChaCha20-Poly1305(key, nonce, payload, aad = transcript)
```

The response goes as notifications of at most `ATT MTU − 3` bytes, prefixed by
its length (4 bytes, big endian, at most 16 KiB).

**Crypto** (`utils/contactExchange/crypto.ts`, @noble/curves and
@noble/ciphers, @noble/hashes):

```text
transcript = "gossip-contact-exchange/1" ‖ header (73) ‖ B
shared     = X25519(a, B) = X25519(b, A)        (low-order keys are refused)
key        = HKDF-SHA256(shared, salt = rendezvous id, info = transcript, 32 bytes)
```

The scanner opens the response, checks that the payload's header is the one it
read, then that the keys hash to the user id. The native side only moves bytes;
all crypto runs in JS. Ephemeral secret keys live in memory while the code is on
screen (presenter) or for one attempt (scanner), and are wiped after.

**Limits.** The presenter answers one request per phone (BLE address), at most
16 per code and 2 at a time, drops a request not answered in 15 s, and ignores
writes that are not one 33-byte write from a subscribed phone. It stops
advertising when the code leaves the screen, when the app goes to the
background, and after 2 minutes ("Start again" makes a new code). The scanner
tries twice, 25 s each, while the camera keeps reading.

**Next to the mesh (Android).** All GATT servers of an app share the phone's
connections, so the mesh radio sees exchange connections too. While an exchange
runs (`ContactExchangeGate`), the mesh leaves connections it does not admit
unused instead of cancelling them, so it cannot cut the exchange's link.

## Threat model

- **Bystander listening to Bluetooth**: sees a random UUID advertised for at
  most 2 minutes and an X25519 exchange; the keys are encrypted under a key it
  cannot derive.
- **Bystander filming the screen**: reads the keys from the QR frames, as with
  any QR code. The public keys and user id are what the person is sharing; they
  let the viewer link them to the person and send them a contact request.
  Showing the code is the user's choice, in person.
- **Impostor** (another phone advertising the same UUID, or a modified
  presenter): it does not know `a`, so its answer does not open; and keys that
  do not hash to the user id read from the code are refused either way. At
  worst it delays the exchange; the camera path keeps going.
- **Someone replaying a request**: one answer per phone and few per code; each
  answer is sealed for the requester's fresh key.
- **Deniability**: nothing is signed; the exchange only moves public keys, so
  it proves nothing about who took part, and sessions start as for any contact.
- **Nothing is stored**: no keys are published to a server or the mesh,
  ephemeral keys are not kept, and the contact is only added if the user
  confirms the form.

## Limits

- Real phone-to-phone scanning and the Bluetooth exchange have been built and
  unit-tested, not tried on devices yet; the iOS code has not been compiled
  (written on Linux).
- iOS gives each app one advertising slot: with the mesh on, advertising the
  exchange UUID next to the mesh's may not work on every iOS version; the
  animated code still does.
- Android phones without multiple advertising sets cannot advertise the code
  while the mesh advertises; the animated code still works.
- In the background, iOS does not advertise the code's UUID in the main packet;
  the code is meant to be shown with the app open, and Bluetooth stops when the
  app leaves the foreground.
