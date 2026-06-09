import { describe, expect, test } from "bun:test";
import { fromBytes, toBytes } from "../quazal/rmc/basic";
import { openAny } from "../quazal/rmc/types";
import { LoginExRequest, UbiAuthenticationLoginCustomData } from "./ticket-granting.types";

// The parameters of a captured LoginEx RMC request (same vector as the legacy
// loginex-request.model.test.ts).
const REAL_PACKET =
  "0f0073616d5f7468655f66697368657200210055626941757468656e7469636174696f6e4c6f67696e437573746f6d44617461003a000000360000000f0073616d5f7468655f666973686572001400414243442d454647482d494a4b4c2d4d4e4f50000d0070617373776f72643132333400";

describe("LoginExRequest", () => {
  test("decodes the captured request", () => {
    const req = fromBytes(LoginExRequest, Uint8Array.from(Buffer.from(REAL_PACKET, "hex")));
    expect(req.strUserName).toBe("sam_the_fisher");
    expect(req.oExtraData.typeName).toBe("UbiAuthenticationLoginCustomData");

    const custom = openAny(req.oExtraData, UbiAuthenticationLoginCustomData);
    expect(custom.userName).toBe("sam_the_fisher");
    expect(custom.onlineKey).toBe("ABCD-EFGH-IJKL-MNOP");
    expect(custom.password).toBe("password1234");
  });

  test("re-encodes byte-exact", () => {
    const req = fromBytes(LoginExRequest, Uint8Array.from(Buffer.from(REAL_PACKET, "hex")));
    expect(Buffer.from(toBytes(LoginExRequest, req)).toString("hex")).toBe(REAL_PACKET);
  });
});
