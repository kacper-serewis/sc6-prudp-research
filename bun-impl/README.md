# bun-impl

A TypeScript ([Bun](https://bun.sh)) server for the multiplayer of *Splinter Cell: Blacklist*.

> **Based on [5th-echelon](https://github.com/unixoide/5th-echelon)** by unixoide and contributors.
> This is a port of its Rust dedicated server (upstream commit `36ec58e`). See [Credits](#credits).

It implements everything the Rust `dedicated_server` does:

- the Quazal **PRUDP** transport (handshake, RC4 + zlib payloads, checksums, fragmentation, pings, session expiry)
- **RMC** dispatch, with all 28 protocols of the game generated from its DDL
- the **authentication** service (`sc_bl_auth`): `Login`, `LoginEx`, `RequestTicket` with Kerberos-style tickets
- the **secure** service (`sc_bl_secure`): 18 protocols (secure connection, game sessions, NAT traversal, account lookups, stats, Overlord news/config/challenges, ...)
- the **online config** and **content** HTTP services
- the **gRPC API** used by the 5th-echelon launcher (register/login, friends, invites, P2P test, admin services)
- SQLite storage

It reads the same `service.toml` and uses the same `5th-echelon.db` as the Rust server. Both servers can
be swapped on the same files.

## Running

```sh
bun install
bun run start                          # = bun run src/main.ts
bun run start --public-ip 203.0.113.7  # advertise this address instead of 127.0.0.1
```

On first start this creates `service.toml` (same defaults as the Rust server, with a new ticket key),
`5th-echelon.db` and `server.log.json` in the working directory. Options:

| Option | |
|---|---|
| `-c, --config <path>` | config file (default `service.toml`) |
| `--public-ip <ip>` | rewrites the secure server address, the content host and the sandbox URLs clients get |
| `--launcher` | log to `server.log.json` only, enable the admin gRPC services and print their key (`Admin Key: ...`) |
| `LOG_LEVEL` / `RUST_LOG` | terminal log level: `trace`, `debug`, `info` (default), `warn`, `error`, `crit` |

Default ports:

| Service | Port | |
|---|---|---|
| `sc_bl_auth` | 21126/udp | authentication, the game's sandbox URL points here |
| `sc_bl_secure` | 21127/udp | everything after login |
| `onlineconfig` | 80/tcp | online configuration the game requests on start |
| `content` | 8000/tcp | `mp_balancing.ini` |
| API | 50051/tcp | gRPC for the launcher |

`data/` contains the files served by default (`mp_balancing.ini`, `news.json`, `challenges.json`).
They are read from the working directory, like the Rust server does.

### Accounts

Players register through the launcher (gRPC `users.Users/Register`) and log in with that username
and password. The database migrations come from upstream and seed some accounts, including
`sam_the_fisher` / `password1234` and the `Tracking` account the game uses internally. Remove or change
the test accounts on a public server.

## Layout

```
src/
  main.ts              entry point (port of dedicated_server/src/main.rs)
  config.ts            service.toml
  server.ts            wires PRUDP servers, RMC dispatchers and services
  quazal/              protocol library (port of the `quazal` crate)
    prudp/             packets and the UDP server
    rmc/               RMC messages, errors and protocol dispatch
    codec.ts types.ts  wire encoding (strings, lists, maps, any, variants, station URLs, ...)
    kerberos.ts        tickets
  protocols/           GENERATED from ddl/ by scripts/generate-protocols.ts
  services/            protocol implementations (ports of dedicated_server/src/*.rs)
  storage/             SQLite storage and the upstream migrations
  http/                online config and content services
  api/                 gRPC API (protos in proto/)
ddl/                   protocol definitions extracted from the game (from 5th-echelon)
```

## Protocols

The game describes its RMC protocols in DDL, Quazal's interface definition format: methods (their
position is the method id), parameters with direction, and classes with field order and types.
Protocol ids come from `ddl/sc_bl_mapping.json`. The wire format has no tags or lengths, so these
definitions are what makes the encoding correct.

```sh
bun run generate                                            # ddl/*.json -> src/protocols
bun run verify-protocols /path/to/5th-echelon               # compare with the Rust generated code
```

`verify-protocols` compares ids, method numbers and the field layout of every class, request and
response with the protocol code of the Rust server (currently 55 modules, 589 structs, 251 methods).

The Overlord protocols (5002 news, 5003 config, 5007 challenges) are not part of the DDL and are
written by hand in `src/services/overlord.ts`, like upstream.

## Tools

```sh
# Decode PRUDP packets (hex, one per line or as arguments), including the RMC calls inside
bun run scripts/decode.ts 3f3120000000000000000000000040
# gRPC API client (port of the Rust `cli` binary)
bun run scripts/api-cli.ts send-invite -u sam_the_fisher -p password1234 --url 127.0.0.1:50051 ABCD
bun run scripts/api-cli.ts get-event -u sam_the_fisher -p password1234
```

## Tests

```sh
bun test
bun run typecheck
```

- unit tests with the upstream test vectors (packets, RMC, codecs, Kerberos, storage, config)
- `test/fixtures/rust-session.txt`: a recorded game session. Every packet in it has to parse and
  re-encode byte for byte (except one corrupt compressed packet from the recording).
- `test/e2e.test.ts`: a client that behaves like the game talks UDP to the servers
- `test/differential.test.ts`: starts this server and the Rust server from equivalent configs,
  sends both the same traffic (HTTP, gRPC, the 39 RMC calls from the recorded session, game
  sessions, NAT probes) and compares the answers. It needs a build of the Rust server:

  ```sh
  cd /path/to/5th-echelon
  cargo build -p dedicated_server   # debug build: the stripped release build fails to link on recent macOS
  cd -
  RUST_SERVER=/path/to/5th-echelon/target/debug/dedicated_server bun test test/differential.test.ts
  ```

## Differences to the Rust server

Deliberate changes, all covered by tests:

- `TicketGrantingProtocol.Login` only works for accounts with a plaintext password (the game uses it
  for `Tracking`). Upstream returns a ticket for any username, encrypted with a public default
  password for everyone else, so anyone could log in as another player.
- Inputs that crash a Rust service thread (unknown `any` class, a game session whose host left,
  empty attribute lists, invalid USER packets, `Route`/`Raw` packets) are answered with an error or
  ignored instead.
- Idle clients are expired on a timer. The Rust server only checks when the socket has been idle for
  a second, and never expires half-open (SYN-only) connections.
- Limits against malicious clients: payloads may inflate to at most 64 KiB, a client may buffer at
  most 1 MiB of fragments, HTTP request lines are capped at 8 KiB with a 10 s deadline, compressed
  USER packets aren't echoed (the NAT echo would amplify them), and logged hex dumps are truncated.
- Password hashing runs on Bun's worker threads and derived ticket keys are cached, so logins don't
  block the other services, which share one event loop here.
- Services without a `ticket_key` share one generated key, so tickets from the authentication service
  still work on the secure service.
- The `tracking = "true"` service setting replaces the `tracking` cargo feature.
- `--public-ip` has no counterpart in the Rust server. There, the launcher edits `service.toml`.

Parameter order in station URLs is stable (insertion order) instead of Rust's random `HashMap` order.

## Credits

This server is based on the [5th-echelon](https://github.com/unixoide/5th-echelon) repository, the
community server for the *Splinter Cell* games. The Quazal protocol implementation, the server logic
and the tooling are ported from its Rust code. The protocol definitions (`ddl/`), gRPC protos
(`proto/`), data files (`data/`), database migrations and test vectors are taken from it. All credit
for reverse engineering the game's network protocols goes to the 5th-echelon project.
