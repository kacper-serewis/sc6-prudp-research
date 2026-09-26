import { expect, test } from "bun:test";
import { hexPreview } from "./logger";

test("hexPreview truncates large payloads", () => {
  expect(hexPreview(Buffer.from([1, 2, 0xff]))).toBe("0102ff");
  expect(hexPreview(Buffer.alloc(300), 4)).toBe("00000000... (300 bytes)");
});
