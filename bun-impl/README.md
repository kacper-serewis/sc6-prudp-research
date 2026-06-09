# bun-impl

A TypeScript (Bun) port of the Rust PRUDP/Quazal authentication server, built on
a declarative codec framework that mirrors Rust's `#[derive(ToStream, FromStream)]`.

## Install & run

```bash
bun install
bun test          # codec unit tests + Rust test vectors + whole-capture round-trip
bun index.ts      # offline replay: feed captured client packets, assert responses
DEBUG='*' bun index.ts   # with logging
```

## Layout (mirrors the Rust crate)

```
src/quazal/
  rmc/basic.ts    ReadStream/WriteStream, Codec<T>, Infer<>, primitives,
                  qstring, qbuffer, fixedBytes, list, map, qstruct
  rmc/types.ts    StationURL, qresult, datetime, variant, anyData, property
  rmc/packet.ts   RMC Request/Response framing
  prudp/packet.ts PRUDP packet parse/serialize, VPort, checksum, RC4+zlib
  prudp/crypto.ts RC4 (cryptKey)
  kerberos.ts     ticket sealing (secretbox + RC4 + HMAC-MD5)
  context.ts      Context (accessKey / cryptoKey / ticketKey)
src/protocols/    ticket-granting (protocol 10) types as codecs
src/server/       authentication server, client registry, replay fixture
```

## The codec framework

`qstruct({...})` reads/writes fields in declaration order with no tags or
padding — the equivalent of the Rust derive. `Infer<typeof X>` recovers the
decoded TypeScript type. Example:

```ts
export const LoginExResponse = qstruct({
  returnValue: qresult,
  pidPrincipal: u32,
  pbufResponse: qbuffer,
  pConnectionData: RVConnectionData,
  strReturnMsg: qstring,
});
type LoginExResponse = Infer<typeof LoginExResponse>;
```

## Replay & the compression caveat

`index.ts` replays the captured Syn / Connect / LoginEx packets and asserts the
server's responses match the capture. Syn/Connect acks are byte-exact. The
LoginEx Data response is RC4'd over a zlib stream, and `node:zlib` deflate(level
6) does not produce the same bytes as Rust's `miniz_oxide`, so that packet is
verified at the **decrypted + decompressed plaintext** level instead (plus the
PRUDP header fields). Ticket randomness is removed by injecting the captured
session key and secretbox nonce (`src/server/replay-fixture.ts`), whose values
are re-derived from the capture end-to-end in `replay-fixture.test.ts`.
