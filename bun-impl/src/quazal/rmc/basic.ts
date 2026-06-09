// Quazal RMC basic (de)serialization framework.
// TypeScript equivalent of quazal/src/rmc/basic.rs + the ToStream/FromStream
// derive macros: declarative codecs with full type inference.
// All multi-byte values are little-endian; there are intentionally no BE methods.

export class ReadStream {
  private view: DataView;
  private pos = 0;

  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  private need(n: number) {
    if (this.pos + n > this.data.length) {
      throw new Error(
        `${this.pos + n - this.data.length} bytes missing (want ${n} at offset ${this.pos}, length ${this.data.length})`
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  readAll(): Uint8Array {
    return this.bytes(this.remaining);
  }

  read<T>(codec: Codec<T>): T {
    return codec.read(this);
  }
}

export class WriteStream {
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.len, v);
    this.len += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  }
  u64(v: bigint): this {
    this.ensure(8);
    this.view.setBigUint64(this.len, BigInt.asUintN(64, v), true);
    this.len += 8;
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.len, v);
    this.len += 1;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.len, v, true);
    this.len += 2;
    return this;
  }
  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.len, v, true);
    this.len += 4;
    return this;
  }
  i64(v: bigint): this {
    this.ensure(8);
    this.view.setBigInt64(this.len, BigInt.asIntN(64, v), true);
    this.len += 8;
    return this;
  }
  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  }
  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.len, v, true);
    this.len += 8;
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  bytes(data: Uint8Array): this {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
    return this;
  }

  write<T>(codec: Codec<T>, value: T): this {
    codec.write(this, value);
    return this;
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export interface Codec<T> {
  read(s: ReadStream): T;
  write(s: WriteStream, v: T): void;
}

export type Infer<C> = C extends Codec<infer T> ? T : never;

export function toBytes<T>(codec: Codec<T>, value: T): Uint8Array {
  const s = new WriteStream();
  codec.write(s, value);
  return s.toBytes();
}

/** Decodes a value from bytes. Like Rust's `from_bytes`, trailing bytes are tolerated. */
export function fromBytes<T>(codec: Codec<T>, data: Uint8Array): T {
  return codec.read(new ReadStream(data));
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

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Quazal string: u16 length (including the null terminator) + UTF-8 bytes + `\0`.
 * The empty string is encoded as just `00 00` (basic.rs:445-458).
 */
export const qstring: Codec<string> = {
  read(s) {
    const len = s.u16();
    if (len === 0) return "";
    const data = s.bytes(len);
    if (data[len - 1] !== 0) {
      throw new Error("string is not null-terminated");
    }
    return utf8Decoder.decode(data.subarray(0, len - 1));
  },
  write(s, v) {
    if (v.length === 0) {
      s.u16(0);
      return;
    }
    const data = utf8Encoder.encode(v);
    s.u16(data.length + 1);
    s.bytes(data);
    s.u8(0);
  },
};

/** Quazal byte buffer (`Vec<u8>` / qbuffer): u32 count + raw bytes. */
export const qbuffer: Codec<Uint8Array> = {
  read(s) {
    const len = s.u32();
    return s.bytes(len);
  },
  write(s, v) {
    s.u32(v.length);
    s.bytes(v);
  },
};

/** Fixed-size byte array (Rust `[u8; N]`): raw bytes, no length prefix. */
export function fixedBytes(n: number): Codec<Uint8Array> {
  return {
    read: (s) => s.bytes(n),
    write(s, v) {
      if (v.length !== n) {
        throw new Error(`expected ${n} bytes, got ${v.length}`);
      }
      s.bytes(v);
    },
  };
}

/** `Vec<T>` / QList: u32 count + elements. */
export function list<T>(elem: Codec<T>): Codec<T[]> {
  return {
    read(s) {
      const len = s.u32();
      const res: T[] = [];
      for (let i = 0; i < len; i++) res.push(elem.read(s));
      return res;
    },
    write(s, v) {
      s.u32(v.length);
      for (const item of v) elem.write(s, item);
    },
  };
}

/** `HashMap<K, V>`: u32 count + key/value pairs. Insertion order is preserved on write. */
export function map<K, V>(key: Codec<K>, value: Codec<V>): Codec<Map<K, V>> {
  return {
    read(s) {
      const len = s.u32();
      const res = new Map<K, V>();
      for (let i = 0; i < len; i++) {
        const k = key.read(s);
        const v = value.read(s);
        res.set(k, v);
      }
      return res;
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

/**
 * Struct codec: fields are read/written in declaration order with no tags or
 * padding — the equivalent of Rust's `#[derive(ToStream, FromStream)]`.
 */
export function qstruct<F extends Record<string, Codec<any>>>(
  fields: F
): Codec<{ [K in keyof F]: Infer<F[K]> }> {
  const entries = Object.entries(fields);
  return {
    read(s) {
      const res: Record<string, unknown> = {};
      for (const [name, codec] of entries) res[name] = codec.read(s);
      return res as { [K in keyof F]: Infer<F[K]> };
    },
    write(s, v) {
      for (const [name, codec] of entries) codec.write(s, (v as Record<string, unknown>)[name]);
    },
  };
}
