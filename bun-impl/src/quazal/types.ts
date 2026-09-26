/**
 * Quazal specific data types (port of `quazal::rmc::types`).
 */
import { buffer, decode, encode, f64, i64, bool, string, struct, u32, u64, type Codec, type Infer } from "./codec";
import { StreamError } from "./stream";

/** `qresult`. See `result.ts` for the known error codes. */
export const qresult: Codec<number> = u32;

/** Success value of a `qresult`. */
export const QRESULT_OK = 0x10001;

/** Packed timestamp: `year << 26 | month << 22 | day << 17 | hour << 12 | minute << 6 | second`. */
export const dateTime: Codec<bigint> = u64;

export function dateTimeFromDate(date: Date): bigint {
  return (
    (BigInt(date.getUTCFullYear()) << 26n) |
    (BigInt(date.getUTCMonth() + 1) << 22n) |
    (BigInt(date.getUTCDate()) << 17n) |
    (BigInt(date.getUTCHours()) << 12n) |
    (BigInt(date.getUTCMinutes()) << 6n) |
    BigInt(date.getUTCSeconds())
  );
}

export class StationURLParseError extends StreamError {
  override name = "StationURLParseError";
}

/**
 * A station URL like `prudp:/address=127.0.0.1;port=3074;sid=15;type=3`.
 *
 * Parameters keep their insertion order, `address` and `port` are always serialized first.
 */
export class StationURL {
  constructor(
    public scheme = "",
    public address = "",
    public port = 0,
    public params = new Map<string, string>(),
  ) {}

  static parse(value: string): StationURL {
    const schemeEnd = value.indexOf(":/");
    if (schemeEnd < 0) {
      throw new StationURLParseError(`missing scheme in station url "${value}"`);
    }
    const params = new Map<string, string>();
    for (const param of value.slice(schemeEnd + 2).split(";")) {
      const eq = param.indexOf("=");
      if (eq < 0) {
        throw new StationURLParseError(`invalid parameters in station url "${value}"`);
      }
      params.set(param.slice(0, eq), param.slice(eq + 1));
    }
    const address = params.get("address");
    if (address === undefined) {
      throw new StationURLParseError(`missing address in station url "${value}"`);
    }
    const port = params.get("port");
    if (port === undefined) {
      throw new StationURLParseError(`missing port in station url "${value}"`);
    }
    if (!/^\+?\d+$/.test(port) || Number(port) > 0xffff) {
      throw new StationURLParseError(`invalid port in station url "${value}"`);
    }
    params.delete("address");
    params.delete("port");
    return new StationURL(value.slice(0, schemeEnd), address, Number(port), params);
  }

  toString() {
    const params = [`address=${this.address}`, `port=${this.port}`];
    for (const [key, value] of this.params) {
      params.push(`${key}=${value}`);
    }
    return `${this.scheme}:/${params.join(";")}`;
  }

  /** Shown as `StationURL(prudp:/address=...)` in logs. */
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `StationURL(${this.toString()})`;
  }
}

export const stationUrl: Codec<StationURL> = {
  read: (s) => StationURL.parse(string.read(s)),
  write: (s, v) => string.write(s, v.toString()),
};

export type Variant =
  | { type: "none" }
  | { type: "i64"; value: bigint }
  | { type: "f64"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "string"; value: string }
  | { type: "datetime"; value: bigint }
  | { type: "u64"; value: bigint };

export const Variant = {
  none: (): Variant => ({ type: "none" }),
  i64: (value: bigint | number): Variant => ({ type: "i64", value: BigInt(value) }),
  f64: (value: number): Variant => ({ type: "f64", value }),
  bool: (value: boolean): Variant => ({ type: "bool", value }),
  string: (value: string): Variant => ({ type: "string", value }),
  datetime: (value: bigint | number): Variant => ({ type: "datetime", value: BigInt(value) }),
  u64: (value: bigint | number): Variant => ({ type: "u64", value: BigInt(value) }),
};

/** A type tag byte followed by the value. */
export const variant: Codec<Variant> = {
  read(s) {
    const tag = s.u8();
    switch (tag) {
      case 0:
        return { type: "none" };
      case 1:
        return { type: "i64", value: i64.read(s) };
      case 2:
        return { type: "f64", value: f64.read(s) };
      case 3:
        return { type: "bool", value: bool.read(s) };
      case 4:
        return { type: "string", value: string.read(s) };
      case 5:
        return { type: "datetime", value: dateTime.read(s) };
      case 6:
        return { type: "u64", value: u64.read(s) };
      default:
        throw new StreamError(`invalid variant type ${tag}`);
    }
  },
  write(s, v) {
    switch (v.type) {
      case "none":
        s.u8(0);
        break;
      case "i64":
        i64.write(s.u8(1), v.value);
        break;
      case "f64":
        f64.write(s.u8(2), v.value);
        break;
      case "bool":
        bool.write(s.u8(3), v.value);
        break;
      case "string":
        string.write(s.u8(4), v.value);
        break;
      case "datetime":
        dateTime.write(s.u8(5), v.value);
        break;
      case "u64":
        u64.write(s.u8(6), v.value);
        break;
    }
  },
};

/**
 * `any<Data,string>`: a class name followed by the serialized object.
 * The object is wrapped in two length prefixed buffers on the wire.
 */
export interface AnyData {
  typeName: string;
  data: Buffer;
}

export const anyData: Codec<AnyData> = {
  read(s) {
    const typeName = string.read(s);
    const data = decode(buffer, buffer.read(s));
    return { typeName, data };
  },
  write(s, v) {
    string.write(s, v.typeName);
    buffer.write(s, encode(buffer, v.data));
  },
};

/** Base class of all DDL classes. It has no fields and therefore no wire representation. */
export const Data = struct({});
export type Data = Infer<typeof Data>;

export const Property = struct({ id: u32, value: u32 });
export type Property = Infer<typeof Property>;

export const PropertyVariant = struct({ id: u32, value: variant });
export type PropertyVariant = Infer<typeof PropertyVariant>;

export const ResultRange = struct({ offset: u32, size: u32 });
export type ResultRange = Infer<typeof ResultRange>;

/** Formats properties as `id => value;id => value`, the storage format of the Rust server. */
export function formatProperties(properties: Property[]): string {
  return properties.map((p) => `${p.id} => ${p.value}`).join(";");
}

export function parseProperties(value: string): Property[] {
  if (value === "") {
    return [];
  }
  return value.split(";").map((entry) => {
    const match = /^(\d+) => (\d+)$/.exec(entry);
    const id = Number(match?.[1]);
    const val = Number(match?.[2]);
    if (!match || id > 0xffffffff || val > 0xffffffff) {
      throw new Error(`invalid property "${entry}"`);
    }
    return { id, value: val };
  });
}
