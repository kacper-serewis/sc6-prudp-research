/**
 * Composable (de)serializers for the Quazal RMC encoding.
 *
 * This replaces the `FromStream`/`ToStream` traits and derive macros of the Rust
 * implementation: every wire type is described by a `Codec`, and structs are
 * encoded as their fields in declaration order without any header.
 */
import { ReadStream, StreamError, WriteStream } from "./stream";

export interface Codec<T> {
  read(stream: ReadStream): T;
  write(stream: WriteStream, value: T): void;
}

/** Extracts the value type of a codec. */
export type Infer<C> = C extends Codec<infer T> ? T : never;

/** Decodes a value. Trailing bytes are ignored, just like `FromStream::from_bytes`. */
export function decode<T>(codec: Codec<T>, data: Buffer): T {
  return codec.read(new ReadStream(data));
}

export function encode<T>(codec: Codec<T>, value: T): Buffer {
  const stream = new WriteStream();
  codec.write(stream, value);
  return stream.toBuffer();
}

export const u8: Codec<number> = { read: (s) => s.u8(), write: (s, v) => void s.u8(v) };
export const u16: Codec<number> = { read: (s) => s.u16(), write: (s, v) => void s.u16(v) };
export const u32: Codec<number> = { read: (s) => s.u32(), write: (s, v) => void s.u32(v) };
export const u64: Codec<bigint> = { read: (s) => s.u64(), write: (s, v) => void s.u64(v) };
export const i8: Codec<number> = { read: (s) => s.i8(), write: (s, v) => void s.i8(v) };
export const i16: Codec<number> = { read: (s) => s.i16(), write: (s, v) => void s.i16(v) };
export const i32: Codec<number> = { read: (s) => s.i32(), write: (s, v) => void s.i32(v) };
export const i64: Codec<bigint> = { read: (s) => s.i64(), write: (s, v) => void s.i64(v) };
export const f32: Codec<number> = { read: (s) => s.f32(), write: (s, v) => void s.f32(v) };
export const f64: Codec<number> = { read: (s) => s.f64(), write: (s, v) => void s.f64(v) };
export const bool: Codec<boolean> = { read: (s) => s.bool(), write: (s, v) => void s.bool(v) };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * `u16` length (including the terminator) followed by the NUL-terminated UTF-8 data.
 * An empty string is encoded as a zero length without terminator.
 */
export const string: Codec<string> = {
  read(s) {
    const len = s.u16();
    if (len === 0) {
      return "";
    }
    const data = s.bytes(len);
    if (data.indexOf(0) !== len - 1) {
      throw new StreamError("string is not a valid NUL-terminated C string");
    }
    try {
      return utf8.decode(data.subarray(0, len - 1));
    } catch {
      throw new StreamError("string is not valid UTF-8");
    }
  },
  write(s, v) {
    if (v.length === 0) {
      s.u16(0);
      return;
    }
    const data = Buffer.from(v, "utf8");
    s.u16(data.length + 1).bytes(data).u8(0);
  },
};

/** `u32` length prefixed bytes (`buffer`, `Vec<u8>` in Rust). */
export const buffer: Codec<Buffer> = {
  read: (s) => s.bytes(s.u32()),
  write: (s, v) => void s.u32(v.length).bytes(v),
};

/** `u16` length prefixed bytes (`qBuffer`). */
export const qBuffer: Codec<Buffer> = {
  read: (s) => s.bytes(s.u16()),
  write: (s, v) => void s.u16(v.length).bytes(v),
};

/** Exactly `size` bytes without a length prefix (`[u8; N]` in Rust). */
export function fixedBytes(size: number): Codec<Buffer> {
  return {
    read: (s) => s.bytes(size),
    write(s, v) {
      if (v.length !== size) {
        throw new RangeError(`expected ${size} bytes, got ${v.length}`);
      }
      s.bytes(v);
    },
  };
}

/** All remaining bytes (`buffertail`). */
export const bufferTail: Codec<Buffer> = {
  read: (s) => s.rest(),
  write: (s, v) => void s.bytes(v),
};

/** `u32` element count followed by the elements (`qlist`, `qvector`, `std_list`). */
export function list<T>(item: Codec<T>): Codec<T[]> {
  return {
    read(s) {
      const count = s.u32();
      const result: T[] = [];
      for (let i = 0; i < count; i++) {
        result.push(item.read(s));
      }
      return result;
    },
    write(s, v) {
      s.u32(v.length);
      for (const element of v) {
        item.write(s, element);
      }
    },
  };
}

/** `u32` entry count followed by key/value pairs (`std_map`). */
export function map<K, V>(key: Codec<K>, value: Codec<V>): Codec<Map<K, V>> {
  return {
    read(s) {
      const count = s.u32();
      const result = new Map<K, V>();
      for (let i = 0; i < count; i++) {
        const k = key.read(s);
        result.set(k, value.read(s));
      }
      return result;
    },
    write(s, v) {
      s.u32(v.size);
      for (const [k, val] of v) {
        key.write(s, k);
        value.write(s, val);
      }
    },
  };
}

export type StructValue<F extends Record<string, Codec<any>>> = { [K in keyof F]: Infer<F[K]> };

/** Fields encoded one after another in declaration order. */
export function struct<F extends Record<string, Codec<any>>>(fields: F): Codec<StructValue<F>> {
  const entries = Object.entries(fields);
  return {
    read(s) {
      const result: Record<string, unknown> = {};
      for (const [name, codec] of entries) {
        result[name] = codec.read(s);
      }
      return result as StructValue<F>;
    },
    write(s, v) {
      for (const [name, codec] of entries) {
        codec.write(s, (v as Record<string, unknown>)[name]);
      }
    },
  };
}

/** Defers codec lookup, for types that are declared later. */
export function lazy<T>(get: () => Codec<T>): Codec<T> {
  return {
    read: (s) => get().read(s),
    write: (s, v) => get().write(s, v),
  };
}
