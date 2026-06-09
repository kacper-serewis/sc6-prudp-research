import { describe, expect, test } from "bun:test";
import {
  type Codec,
  ReadStream,
  WriteStream,
  bool,
  f32,
  f64,
  fixedBytes,
  fromBytes,
  i16,
  i32,
  i64,
  i8,
  list,
  map,
  qbuffer,
  qstring,
  qstruct,
  toBytes,
  u16,
  u32,
  u64,
  u8,
} from "./basic";

function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

function fromHex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

function roundTrip<T>(codec: Codec<T>, value: T): T {
  return fromBytes(codec, toBytes(codec, value));
}

describe("streams", () => {
  test("all numeric writes are little-endian", () => {
    const s = new WriteStream();
    s.u16(0x1234);
    s.u32(0xdeadbeef);
    s.u64(0x1122334455667788n);
    expect(hex(s.toBytes())).toBe("3412efbeadde8877665544332211");
  });

  test("read stream matches write stream", () => {
    const s = new WriteStream();
    s.u8(7).i8(-3).u16(0xffee).i16(-2).u32(123456789).i32(-123456789);
    s.u64(2n ** 63n).i64(-42n).f32(1.5).f64(-2.25).bool(true).bool(false);
    const r = new ReadStream(s.toBytes());
    expect(r.u8()).toBe(7);
    expect(r.i8()).toBe(-3);
    expect(r.u16()).toBe(0xffee);
    expect(r.i16()).toBe(-2);
    expect(r.u32()).toBe(123456789);
    expect(r.i32()).toBe(-123456789);
    expect(r.u64()).toBe(2n ** 63n);
    expect(r.i64()).toBe(-42n);
    expect(r.f32()).toBe(1.5);
    expect(r.f64()).toBe(-2.25);
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
    expect(r.remaining).toBe(0);
  });

  test("read past end throws", () => {
    const r = new ReadStream(new Uint8Array([1]));
    expect(() => r.u32()).toThrow("bytes missing");
  });

  test("readAll returns remaining bytes", () => {
    const r = new ReadStream(fromHex("01020304"));
    r.u8();
    expect(hex(r.readAll())).toBe("020304");
  });

  test("write stream grows past initial capacity", () => {
    const s = new WriteStream();
    const chunk = new Uint8Array(1000).fill(0xab);
    s.bytes(chunk);
    s.bytes(chunk);
    expect(s.toBytes().length).toBe(2000);
    expect(s.toBytes()[1999]).toBe(0xab);
  });
});

describe("primitive codecs", () => {
  test("round-trips", () => {
    expect(roundTrip(u8, 0xff)).toBe(0xff);
    expect(roundTrip(u16, 0xffff)).toBe(0xffff);
    expect(roundTrip(u32, 0xffffffff)).toBe(0xffffffff);
    expect(roundTrip(u64, 0xffffffffffffffffn)).toBe(0xffffffffffffffffn);
    expect(roundTrip(i8, -128)).toBe(-128);
    expect(roundTrip(i16, -32768)).toBe(-32768);
    expect(roundTrip(i32, -2147483648)).toBe(-2147483648);
    expect(roundTrip(i64, -(2n ** 63n))).toBe(-(2n ** 63n));
    expect(roundTrip(f32, 0.5)).toBe(0.5);
    expect(roundTrip(f64, Math.PI)).toBe(Math.PI);
    expect(roundTrip(bool, true)).toBe(true);
    expect(roundTrip(bool, false)).toBe(false);
  });

  test("fromBytes tolerates trailing bytes (Rust from_bytes parity)", () => {
    // From Rust test: registry.instantiate("u8", b"ABCD") == 0x41
    expect(fromBytes(u8, fromHex("41424344"))).toBe(0x41);
    expect(fromBytes(u32, fromHex("41424344"))).toBe(0x44434241);
  });
});

describe("qstring", () => {
  test('known bytes: "ABCD"', () => {
    // From Rust test: b"\x05\x00ABCD\x00" == "ABCD"
    const wire = "05004142434400";
    expect(hex(toBytes(qstring, "ABCD"))).toBe(wire);
    expect(fromBytes(qstring, fromHex(wire))).toBe("ABCD");
  });

  test("empty string is exactly 00 00", () => {
    expect(hex(toBytes(qstring, ""))).toBe("0000");
    expect(fromBytes(qstring, fromHex("0000"))).toBe("");
  });

  test("utf-8 content", () => {
    const v = "señor żółć";
    expect(roundTrip(qstring, v)).toBe(v);
    const encoded = toBytes(qstring, v);
    // length prefix counts utf-8 bytes (+1 for null), not code units
    expect(encoded[0]).toBe(Buffer.from(v, "utf-8").length + 1);
  });

  test("rejects unterminated strings", () => {
    expect(() => fromBytes(qstring, fromHex("020041 41".replace(/ /g, "")))).toThrow();
  });
});

describe("qbuffer", () => {
  test("u32 count + raw bytes", () => {
    expect(hex(toBytes(qbuffer, fromHex("aabbcc")))).toBe("03000000aabbcc");
    expect(hex(fromBytes(qbuffer, fromHex("03000000aabbcc")))).toBe("aabbcc");
  });

  test("empty buffer", () => {
    expect(hex(toBytes(qbuffer, new Uint8Array(0)))).toBe("00000000");
  });
});

describe("fixedBytes", () => {
  test("raw bytes without prefix", () => {
    const c = fixedBytes(4);
    expect(hex(toBytes(c, fromHex("01020304")))).toBe("01020304");
    expect(hex(fromBytes(c, fromHex("01020304ff")))).toBe("01020304");
  });

  test("rejects wrong size on write", () => {
    expect(() => toBytes(fixedBytes(4), new Uint8Array(3))).toThrow();
  });
});

describe("list", () => {
  test("u32 count + elements", () => {
    expect(hex(toBytes(list(u8), [1, 2, 3]))).toBe("03000000010203");
    expect(fromBytes(list(u16), fromHex("020000000100feff"))).toEqual([1, 0xfffe]);
  });

  test("empty list", () => {
    expect(hex(toBytes(list(u32), []))).toBe("00000000");
  });

  test("list of strings", () => {
    expect(roundTrip(list(qstring), ["a", "", "bc"])).toEqual(["a", "", "bc"]);
  });
});

describe("map", () => {
  test("u32 count + key/value pairs, insertion order preserved", () => {
    const c = map(qstring, qstring);
    const m = new Map([
      ["b", "2"],
      ["a", "1"],
    ]);
    const encoded = toBytes(c, m);
    expect(hex(encoded)).toBe("02000000" + "0200620002003200" + "0200610002003100");
    const decoded = fromBytes(c, encoded);
    expect([...decoded.entries()]).toEqual([
      ["b", "2"],
      ["a", "1"],
    ]);
  });
});

describe("qstruct", () => {
  const Foo = qstruct({
    id: u32,
    name: qstring,
  });

  test("fields in declaration order, no tags", () => {
    const encoded = toBytes(Foo, { id: 1, name: "ABCD" });
    expect(hex(encoded)).toBe("01000000" + "05004142434400");
  });

  test("round-trip with nesting", () => {
    const Bar = qstruct({
      foos: list(Foo),
      blob: qbuffer,
      big: u64,
    });
    const value = {
      foos: [
        { id: 1, name: "x" },
        { id: 2, name: "" },
      ],
      blob: fromHex("0badf00d"),
      big: 0xffffffffffffffffn,
    };
    const decoded = roundTrip(Bar, value);
    expect(decoded.foos).toEqual(value.foos);
    expect(hex(decoded.blob)).toBe("0badf00d");
    expect(decoded.big).toBe(0xffffffffffffffffn);
  });
});
