import { describe, expect, test } from "bun:test";
import { fromBytes, qstring, toBytes } from "./basic";
import {
  QRESULT_OK,
  type Variant,
  anyData,
  datetime,
  makeAny,
  openAny,
  parseStationUrl,
  property,
  qresult,
  stationUrl,
  stationUrlToString,
  variant,
} from "./types";

function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

function fromHex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

describe("StationURL", () => {
  // Ported from the Rust parse_stationurl test (types.rs:428)
  test("parse_stationurl", () => {
    const parsed = parseStationUrl("prudp:/address=127.0.0.1;port=3074;sid=15;type=3");
    expect(parsed.scheme).toBe("prudp");
    expect(parsed.address).toBe("127.0.0.1");
    expect(parsed.port).toBe(3074);
    expect(parsed.params.get("sid")).toBe("15");
    expect(parsed.params.get("type")).toBe("3");
  });

  test("to-string puts address and port first, params in insertion order", () => {
    const s = "prudp:/address=127.0.0.1;port=3074;sid=15;type=3";
    expect(stationUrlToString(parseStationUrl(s))).toBe(s);
  });

  test("default StationURL (Rust StationURL::default()) serializes as :/address=;port=0", () => {
    const parsed = parseStationUrl(":/address=;port=0");
    expect(parsed.scheme).toBe("");
    expect(parsed.address).toBe("");
    expect(parsed.port).toBe(0);
    expect(stationUrlToString(parsed)).toBe(":/address=;port=0");
  });

  test("codec serializes as a qstring", () => {
    const s = "prudp:/address=1.2.3.4;port=1;k=v";
    expect(hex(toBytes(stationUrl, parseStationUrl(s)))).toBe(hex(toBytes(qstring, s)));
    const decoded = fromBytes(stationUrl, toBytes(qstring, s));
    expect(decoded.address).toBe("1.2.3.4");
    expect(decoded.params.get("k")).toBe("v");
  });
});

describe("qresult", () => {
  test("Ok is 0x10001 -> 01 00 01 00", () => {
    expect(hex(toBytes(qresult, QRESULT_OK))).toBe("01000100");
  });
});

describe("datetime", () => {
  test("u64 round-trip", () => {
    const v = 0x1234567890abcdefn;
    expect(fromBytes(datetime, toBytes(datetime, v))).toBe(v);
  });
});

describe("variant", () => {
  const cases: Variant[] = [
    { type: "none" },
    { type: "i64", value: -5n },
    { type: "f64", value: 2.5 },
    { type: "bool", value: true },
    { type: "string", value: "hi" },
    { type: "datetime", value: 123n },
    { type: "u64", value: 0xffffffffffffffffn },
  ];

  test.each(cases.map((c) => [c.type, c] as const))("round-trips %s", (_name, value) => {
    expect(fromBytes(variant, toBytes(variant, value))).toEqual(value);
  });

  test("tags match the Rust enum", () => {
    expect(toBytes(variant, { type: "none" })[0]).toBe(0);
    expect(toBytes(variant, { type: "i64", value: 0n })[0]).toBe(1);
    expect(toBytes(variant, { type: "f64", value: 0 })[0]).toBe(2);
    expect(toBytes(variant, { type: "bool", value: false })[0]).toBe(3);
    expect(toBytes(variant, { type: "string", value: "" })[0]).toBe(4);
    expect(toBytes(variant, { type: "datetime", value: 0n })[0]).toBe(5);
    expect(toBytes(variant, { type: "u64", value: 0n })[0]).toBe(6);
  });

  test("invalid tag throws", () => {
    expect(() => fromBytes(variant, fromHex("07"))).toThrow("invalid variant type");
  });
});

describe("anyData", () => {
  // The oExtraData portion of the captured LoginEx request
  // (REAL_PACKET in the LoginExRequest tests): type name then double size prefix.
  const CAPTURED_ANY =
    "210055626941757468656e7469636174696f6e4c6f67696e437573746f6d44617461003a000000360000000f0073616d5f7468655f666973686572001400414243442d454647482d494a4b4c2d4d4e4f50000d0070617373776f72643132333400";

  test("decodes the captured oExtraData", () => {
    const any = fromBytes(anyData, fromHex(CAPTURED_ANY));
    expect(any.typeName).toBe("UbiAuthenticationLoginCustomData");
    expect(any.data.length).toBe(0x36);
  });

  test("re-encodes byte-exact (double size prefix: u32(N+4) + u32(N))", () => {
    const any = fromBytes(anyData, fromHex(CAPTURED_ANY));
    expect(hex(toBytes(anyData, any))).toBe(CAPTURED_ANY);
  });

  test("openAny/makeAny round-trip", () => {
    const made = makeAny("string", qstring, "ABCD");
    expect(hex(made.data)).toBe("05004142434400");
    expect(openAny(made, qstring)).toBe("ABCD");
    const wire = toBytes(anyData, made);
    // qstring "string" + u32(11) + u32(7) + qstring "ABCD"
    expect(hex(wire)).toBe("0700737472696e67000b0000000700000005004142434400");
  });
});

describe("property", () => {
  test("two u32s", () => {
    expect(hex(toBytes(property, { id: 1, value: 2 }))).toBe("0100000002000000");
  });
});
