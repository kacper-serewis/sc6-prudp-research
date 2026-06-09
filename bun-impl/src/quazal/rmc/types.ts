// Quazal RMC complex types — TypeScript port of quazal/src/rmc/types.rs.
import {
  type Codec,
  type Infer,
  fromBytes,
  qbuffer,
  qstring,
  qstruct,
  toBytes,
  u32,
  u64,
} from "./basic";

/**
 * A `prudp:/address=..;port=..;k=v` URL. `params` is insertion-ordered (Map) so a
 * parsed URL re-serializes byte-exact; Rust uses a HashMap with arbitrary order,
 * so captures are the ground truth for ordering.
 */
export interface StationURL {
  scheme: string;
  address: string;
  port: number;
  params: Map<string, string>;
}

export function parseStationUrl(value: string): StationURL {
  const idx = value.indexOf(":/");
  if (idx < 0) throw new Error(`StationURL is missing a scheme: ${value}`);
  const scheme = value.slice(0, idx);
  const rest = value.slice(idx + 2);

  const params = new Map<string, string>();
  for (const param of rest.split(";")) {
    const eq = param.indexOf("=");
    if (eq < 0) throw new Error(`invalid StationURL parameter: ${param}`);
    params.set(param.slice(0, eq), param.slice(eq + 1));
  }

  const address = params.get("address");
  if (address === undefined) throw new Error(`StationURL is missing an address: ${value}`);
  params.delete("address");
  const portStr = params.get("port");
  if (portStr === undefined) throw new Error(`StationURL is missing a port: ${value}`);
  params.delete("port");
  const port = Number.parseInt(portStr, 10);
  if (Number.isNaN(port)) throw new Error(`invalid StationURL port: ${portStr}`);

  return { scheme, address, port, params };
}

export function stationUrlToString(url: StationURL): string {
  const params = [
    `address=${url.address}`,
    `port=${url.port}`,
    ...[...url.params.entries()].map(([k, v]) => `${k}=${v}`),
  ];
  return `${url.scheme}:/${params.join(";")}`;
}

/** A StationURL is serialized as its string representation (types.rs:65-92). */
export const stationUrl: Codec<StationURL> = {
  read: (s) => parseStationUrl(qstring.read(s)),
  write: (s, v) => qstring.write(s, stationUrlToString(v)),
};

/** QResult code; Ok is 0x10001 (`01 00 01 00` on the wire). */
export const QRESULT_OK = 0x10001;

export const qresult: Codec<number> = u32;

/** DateTime: a u64 packed bitfield (sec/min/hour/day/month/year). */
export const datetime: Codec<bigint> = u64;

export type Variant =
  | { type: "none" }
  | { type: "i64"; value: bigint }
  | { type: "f64"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "string"; value: string }
  | { type: "datetime"; value: bigint }
  | { type: "u64"; value: bigint };

/** Variant: u8 tag (0=None, 1=i64, 2=f64, 3=bool, 4=String, 5=DateTime, 6=u64) + value. */
export const variant: Codec<Variant> = {
  read(s) {
    const tag = s.u8();
    switch (tag) {
      case 0:
        return { type: "none" };
      case 1:
        return { type: "i64", value: s.i64() };
      case 2:
        return { type: "f64", value: s.f64() };
      case 3:
        return { type: "bool", value: s.bool() };
      case 4:
        return { type: "string", value: s.read(qstring) };
      case 5:
        return { type: "datetime", value: s.u64() };
      case 6:
        return { type: "u64", value: s.u64() };
      default:
        throw new Error(`invalid variant type ${tag}`);
    }
  },
  write(s, v) {
    switch (v.type) {
      case "none":
        s.u8(0);
        break;
      case "i64":
        s.u8(1).i64(v.value);
        break;
      case "f64":
        s.u8(2).f64(v.value);
        break;
      case "bool":
        s.u8(3).bool(v.value);
        break;
      case "string":
        s.u8(4).write(qstring, v.value);
        break;
      case "datetime":
        s.u8(5).u64(v.value);
        break;
      case "u64":
        s.u8(6).u64(v.value);
        break;
    }
  },
};

export interface AnyData {
  typeName: string;
  data: Uint8Array;
}

/**
 * `Any<V, String>`: type name (qstring) followed by the payload bytes wrapped in a
 * *double* size prefix — the inner buffer is a `Vec<u8>` serialized into another
 * `Vec<u8>` (types.rs:179-198): `u32(N + 4)` + `u32(N)` + N bytes.
 */
export const anyData: Codec<AnyData> = {
  read(s) {
    const typeName = s.read(qstring);
    const outer = s.read(qbuffer);
    const data = fromBytes(qbuffer, outer);
    return { typeName, data };
  },
  write(s, v) {
    s.write(qstring, v.typeName);
    s.write(qbuffer, toBytes(qbuffer, v.data));
  },
};

/** Decodes the payload of an `Any` value with the given codec. */
export function openAny<T>(any: AnyData, codec: Codec<T>): T {
  return fromBytes(codec, any.data);
}

/** Builds an `Any` value by encoding `value` with the given codec. */
export function makeAny<T>(typeName: string, codec: Codec<T>, value: T): AnyData {
  return { typeName, data: toBytes(codec, value) };
}

export const property = qstruct({
  id: u32,
  value: u32,
});
export type Property = Infer<typeof property>;
