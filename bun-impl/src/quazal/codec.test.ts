import { describe, expect, test } from "bun:test";
import { LoginExRequest } from "../protocols/authentication-foundation/ticket-granting-protocol";
import { UbiAuthenticationLoginCustomData } from "../protocols/ubi-authentication/types";
import * as c from "./codec";
import { StreamError } from "./stream";
import {
  anyData,
  formatProperties,
  parseProperties,
  StationURL,
  stationUrl,
  Variant,
  variant,
} from "./types";

const hex = (data: Buffer) => data.toString("hex");

describe("primitive codecs", () => {
  test("integers are little-endian", () => {
    expect(hex(c.encode(c.u16, 0x1234))).toBe("3412");
    expect(hex(c.encode(c.u32, 0xdeadbeef))).toBe("efbeadde");
    expect(hex(c.encode(c.u64, 0xffff_ffff_ffff_ffffn))).toBe("ffffffffffffffff");
    expect(hex(c.encode(c.i32, -2))).toBe("feffffff");
    expect(c.decode(c.i64, Buffer.from("feffffffffffffff", "hex"))).toBe(-2n);
  });

  test("strings are u16 length prefixed and NUL terminated", () => {
    expect(hex(c.encode(c.string, "de"))).toBe("03006465" + "00");
    expect(hex(c.encode(c.string, ""))).toBe("0000");
    expect(c.decode(c.string, Buffer.from("0000", "hex"))).toBe("");
    expect(c.decode(c.string, Buffer.from("0300646500", "hex"))).toBe("de");
    expect(c.decode(c.string, c.encode(c.string, "Größe ✓"))).toBe("Größe ✓");
  });

  test("malformed strings are rejected like CString::from_vec_with_nul", () => {
    expect(() => c.decode(c.string, Buffer.from("020064", "hex"))).toThrow(StreamError); // truncated
    expect(() => c.decode(c.string, Buffer.from("03006465ff", "hex"))).toThrow(StreamError); // no NUL
    expect(() => c.decode(c.string, Buffer.from("0300640000", "hex"))).toThrow(StreamError); // interior NUL
    expect(() => c.decode(c.string, Buffer.from("0200ff00", "hex"))).toThrow(StreamError); // invalid UTF-8
  });

  test("buffers, lists and maps use u32 counts", () => {
    expect(hex(c.encode(c.buffer, Buffer.from([1, 2])))).toBe("020000000102");
    expect(hex(c.encode(c.list(c.u8), [1, 2]))).toBe("020000000102");
    expect(hex(c.encode(c.qBuffer, Buffer.from([1, 2])))).toBe("02000102");
    const map = new Map([["a", 1]]);
    expect(hex(c.encode(c.map(c.string, c.u32), map))).toBe("01000000" + "02006100" + "01000000");
    expect(c.decode(c.map(c.string, c.u32), c.encode(c.map(c.string, c.u32), map))).toEqual(map);
  });

  test("structs encode fields in order and ignore trailing bytes when decoding", () => {
    const codec = c.struct({ a: c.u8, b: c.string });
    expect(hex(c.encode(codec, { a: 7, b: "x" }))).toBe("07" + "02007800");
    expect(c.decode(codec, Buffer.from("0702007800ffff", "hex"))).toEqual({ a: 7, b: "x" });
  });

  test("write streams grow past their initial capacity", () => {
    const values = Array.from({ length: 300 }, (_, i) => i);
    const encoded = c.encode(c.list(c.u16), values);
    expect(encoded.length).toBe(4 + 600);
    expect(c.decode(c.list(c.u16), encoded)).toEqual(values);
  });

  test("reading past the end throws", () => {
    expect(() => c.decode(c.u32, Buffer.from([1, 2]))).toThrow(StreamError);
    expect(() => c.decode(c.buffer, Buffer.from("05000000aa", "hex"))).toThrow(StreamError);
  });
});

describe("Quazal types", () => {
  test("parses station urls (quazal types.rs test)", () => {
    const url = StationURL.parse("prudp:/address=127.0.0.1;port=3074;sid=15;type=3");
    expect(url.scheme).toBe("prudp");
    expect(url.address).toBe("127.0.0.1");
    expect(url.port).toBe(3074);
    expect(url.params.get("sid")).toBe("15");
    expect(url.params.get("type")).toBe("3");
    expect(url.toString()).toBe("prudp:/address=127.0.0.1;port=3074;sid=15;type=3");
  });

  test("serializes address and port first", () => {
    const url = StationURL.parse("prudps:/PID=2;address=1.2.3.4;CID=1;port=21127");
    expect(url.toString()).toBe("prudps:/address=1.2.3.4;port=21127;PID=2;CID=1");
    expect(new StationURL().toString()).toBe(":/address=;port=0");
    expect(c.decode(stationUrl, c.encode(stationUrl, url)).toString()).toBe(url.toString());
  });

  test("rejects incomplete station urls", () => {
    expect(() => StationURL.parse("address=1;port=2")).toThrow("missing scheme");
    expect(() => StationURL.parse("udp:/port=2")).toThrow("missing address");
    expect(() => StationURL.parse("udp:/address=1")).toThrow("missing port");
    expect(() => StationURL.parse("udp:/address=1;port=x")).toThrow("invalid port");
    expect(() => StationURL.parse("udp:/address=1;port=2;")).toThrow("invalid parameters");
  });

  test("variants round trip", () => {
    for (const value of [
      Variant.none(),
      Variant.i64(-5),
      Variant.f64(1.5),
      Variant.bool(true),
      Variant.string("x"),
      Variant.datetime(0x1f768edbd6n),
      Variant.u64(0xffff_ffff_ffff_ffffn),
    ]) {
      expect(c.decode(variant, c.encode(variant, value))).toEqual(value);
    }
    expect(hex(c.encode(variant, Variant.i64(0x274)))).toBe("01" + "7402000000000000");
    expect(() => c.decode(variant, Buffer.from([7]))).toThrow("invalid variant type 7");
  });

  test("any wraps the object in two length prefixed buffers", () => {
    const encoded = c.encode(anyData, { typeName: "u8", data: Buffer.from([0x41]) });
    expect(hex(encoded)).toBe("0300" + "753800" + "05000000" + "01000000" + "41");
    expect(c.decode(anyData, encoded)).toEqual({ typeName: "u8", data: Buffer.from([0x41]) });
  });

  test("properties use the storage format of the Rust server", () => {
    const props = [
      { id: 101, value: 3578398534 },
      { id: 102, value: 3 },
    ];
    expect(formatProperties(props)).toBe("101 => 3578398534;102 => 3");
    expect(parseProperties("101 => 3578398534;102 => 3")).toEqual(props);
    expect(parseProperties("")).toEqual([]);
    expect(() => parseProperties("1 = 2")).toThrow();
  });
});

describe("generated protocol types", () => {
  // Parameters of a LoginEx call captured from the game.
  const REAL_PACKET =
    "0f0073616d5f7468655f66697368657200210055626941757468656e7469636174696f6e4c6f67696e437573746f6d44617461003a000000360000000f0073616d5f7468655f666973686572001400414243442d454647482d494a4b4c2d4d4e4f50000d0070617373776f72643132333400";

  test("LoginEx parameters decode and re-encode byte for byte", () => {
    const request = c.decode(LoginExRequest, Buffer.from(REAL_PACKET, "hex"));
    expect(request.strUserName).toBe("sam_the_fisher");
    expect(request.oExtraData.typeName).toBe("UbiAuthenticationLoginCustomData");

    const custom = c.decode(UbiAuthenticationLoginCustomData, request.oExtraData.data);
    expect(custom).toEqual({ userName: "sam_the_fisher", onlineKey: "ABCD-EFGH-IJKL-MNOP", password: "password1234" });

    expect(hex(c.encode(LoginExRequest, request))).toBe(REAL_PACKET);
  });

  test("LoginEx parameters can be built from scratch", () => {
    const data = c.encode(UbiAuthenticationLoginCustomData, {
      userName: "sam_the_fisher",
      onlineKey: "ABCD-EFGH-IJKL-MNOP",
      password: "password1234",
    });
    const encoded = c.encode(LoginExRequest, {
      strUserName: "sam_the_fisher",
      oExtraData: { typeName: "UbiAuthenticationLoginCustomData", data },
    });
    expect(hex(encoded)).toBe(REAL_PACKET);
  });
});
