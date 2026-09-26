/**
 * Little-endian byte streams used by every Quazal wire format
 * (port of `quazal::rmc::basic::{ReadStream, WriteStream}`).
 */

/** Raised when a stream does not contain the expected data. */
export class StreamError extends Error {
  override name = "StreamError";
}

export class ReadStream {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get position() {
    return this.offset;
  }

  get remaining() {
    return this.buf.length - this.offset;
  }

  private take(n: number) {
    if (n > this.remaining) {
      throw new StreamError(`${n} bytes missing (only ${this.remaining} left)`);
    }
    const start = this.offset;
    this.offset += n;
    return start;
  }

  u8() {
    return this.buf.readUInt8(this.take(1));
  }
  u16() {
    return this.buf.readUInt16LE(this.take(2));
  }
  u32() {
    return this.buf.readUInt32LE(this.take(4));
  }
  u64() {
    return this.buf.readBigUInt64LE(this.take(8));
  }
  i8() {
    return this.buf.readInt8(this.take(1));
  }
  i16() {
    return this.buf.readInt16LE(this.take(2));
  }
  i32() {
    return this.buf.readInt32LE(this.take(4));
  }
  i64() {
    return this.buf.readBigInt64LE(this.take(8));
  }
  f32() {
    return this.buf.readFloatLE(this.take(4));
  }
  f64() {
    return this.buf.readDoubleLE(this.take(8));
  }
  bool() {
    return this.u8() !== 0;
  }

  /** Reads `n` raw bytes. The result is a copy, so it stays valid when the source buffer is reused. */
  bytes(n: number) {
    const start = this.take(n);
    return Buffer.from(this.buf.subarray(start, start + n));
  }

  /** Reads everything that is left in the stream. */
  rest() {
    return this.bytes(this.remaining);
  }
}

export class WriteStream {
  private buf: Buffer;
  private length = 0;

  constructor(initialCapacity = 64) {
    this.buf = Buffer.alloc(initialCapacity);
  }

  /** Grows the buffer if needed and returns the offset to write `n` bytes at. Call before reading `this.buf`. */
  private reserve(n: number) {
    const required = this.length + n;
    if (required > this.buf.length) {
      const next = Buffer.alloc(Math.max(required, this.buf.length * 2));
      this.buf.copy(next, 0, 0, this.length);
      this.buf = next;
    }
    const start = this.length;
    this.length = required;
    return start;
  }

  u8(v: number) {
    const at = this.reserve(1);
    this.buf.writeUInt8(v, at);
    return this;
  }
  u16(v: number) {
    const at = this.reserve(2);
    this.buf.writeUInt16LE(v, at);
    return this;
  }
  u32(v: number) {
    const at = this.reserve(4);
    this.buf.writeUInt32LE(v, at);
    return this;
  }
  u64(v: bigint) {
    const at = this.reserve(8);
    this.buf.writeBigUInt64LE(v, at);
    return this;
  }
  i8(v: number) {
    const at = this.reserve(1);
    this.buf.writeInt8(v, at);
    return this;
  }
  i16(v: number) {
    const at = this.reserve(2);
    this.buf.writeInt16LE(v, at);
    return this;
  }
  i32(v: number) {
    const at = this.reserve(4);
    this.buf.writeInt32LE(v, at);
    return this;
  }
  i64(v: bigint) {
    const at = this.reserve(8);
    this.buf.writeBigInt64LE(v, at);
    return this;
  }
  f32(v: number) {
    const at = this.reserve(4);
    this.buf.writeFloatLE(v, at);
    return this;
  }
  f64(v: number) {
    const at = this.reserve(8);
    this.buf.writeDoubleLE(v, at);
    return this;
  }
  bool(v: boolean) {
    return this.u8(v ? 1 : 0);
  }

  bytes(data: Uint8Array) {
    const at = this.reserve(data.length);
    this.buf.set(data, at);
    return this;
  }

  toBuffer() {
    return Buffer.from(this.buf.subarray(0, this.length));
  }
}
