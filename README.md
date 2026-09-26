# sc6-prudp-research

Research into the Quazal PRUDP/RMC protocol of *Splinter Cell: Blacklist*.

The TypeScript server in `bun-impl/` is based on the [5th-echelon](https://github.com/unixoide/5th-echelon)
repository: it is a port of its Rust dedicated server.

- `bun-impl/`: a working TypeScript (Bun) server, a port of [5th-echelon](https://github.com/unixoide/5th-echelon). See [bun-impl/README.md](bun-impl/README.md).
- `node-impl/`, `models/`, `*.py`: earlier experiments
- `wireshark-dumps/`, `payloads.json`, `unique-payloads/`: captured traffic
- `mitm-frida/`: Frida scripts to capture the game's traffic
