import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  defaultConfigToml,
  onlineConfigContent,
  parseConfig,
  setPublicIp,
  type OnlineConfigService,
  type QuazalService,
} from "./config";

const rustDefault = readFileSync(new URL("../test/fixtures/rust-service.toml", import.meta.url), "utf8");

function quazal(config: ReturnType<typeof parseConfig>, name: string) {
  return config.services.find((s) => s.name === name) as QuazalService;
}

describe("config", () => {
  test("reads the default service.toml written by the Rust server", () => {
    const config = parseConfig(rustDefault);
    expect(config.services.map((s) => [s.name, s.type])).toEqual([
      ["onlineconfig", "config"],
      ["sc_bl_secure", "secure"],
      ["content", "content"],
      ["sc_bl_auth", "authentication"],
    ]);
    expect(config.apiServer).toEqual({ host: "0.0.0.0", port: 50051 });
    expect(config.debug).toEqual({ markAllAsOnline: false, forceJoins: false });

    const auth = quazal(config, "sc_bl_auth");
    const secure = quazal(config, "sc_bl_secure");
    expect(auth.ctx.accessKey.toString()).toBe("yl4NG7qZ");
    expect(auth.ctx.cryptoKey.toString()).toBe("CD&ML");
    expect(auth.ctx.listen).toEqual({ host: "0.0.0.0", port: 21126 });
    expect(auth.ctx.secureServerAddr).toEqual({ host: "127.0.0.1", port: 21127 });
    expect(auth.ctx.ticketKey.length).toBe(32);
    expect(secure.ctx.ticketKey).toEqual(auth.ctx.ticketKey);
    expect(secure.ctx.settings).toEqual(new Map([["storage_host", "127.0.0.1:8000"], ["storage_path", "/mp_balancing.ini"]]));

    const online = config.services.find((s) => s.type === "config") as OnlineConfigService;
    expect(onlineConfigContent(online)).toBe(
      '[{"Name":"SandboxUrl","Values":["prudp:/address=127.0.0.1;port=21126"]},{"Name":"SandboxUrlWS","Values":["127.0.0.1:21126"]}]',
    );
  });

  test("the generated default is equivalent to the Rust default", () => {
    const ours = parseConfig(defaultConfigToml());
    const theirs = parseConfig(rustDefault);
    const strip = (config: ReturnType<typeof parseConfig>) =>
      config.services
        .map((s) => (s.type === "authentication" || s.type === "secure" ? { ...s, ctx: { ...s.ctx, ticketKey: null } } : s))
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(strip(ours)).toEqual(strip(theirs));
    expect(ours.apiServer).toEqual(theirs.apiServer);
  });

  test("infers the service type and shares generated ticket keys", () => {
    const config = parseConfig(`
      services = ["auth", "secure"]
      [service.auth]
      listen = "127.0.0.1:1"
      secure_server_addr = "127.0.0.1:2"
      [service.secure]
      listen = "[::1]:2"
    `);
    const [auth, secure] = config.services as QuazalService[];
    expect(auth.type).toBe("authentication");
    expect(secure.type).toBe("secure");
    expect(secure.ctx.listen).toEqual({ host: "::1", port: 2 });
    expect(auth.ctx.ticketKey).toEqual(secure.ctx.ticketKey);
  });

  test("rejects unknown services and invalid values", () => {
    expect(() => parseConfig(`services = ["x"]`)).toThrow("Service x not found");
    expect(() => parseConfig(`services = ["x"]\n[service.x]\ntype = "foo"`)).toThrow('"foo" is unknown');
    expect(() => parseConfig(`services = ["x"]\n[service.x]\nticket_key = [1, 2]`)).toThrow("32 bytes");
    expect(() => parseConfig(`services = ["x"]\n[service.x]\nlisten = "nope"`)).toThrow("invalid socket address");
  });

  test("setPublicIp rewrites every advertised address", () => {
    const config = parseConfig(rustDefault);
    setPublicIp(config, "203.0.113.7");
    expect(quazal(config, "sc_bl_auth").ctx.secureServerAddr).toEqual({ host: "203.0.113.7", port: 21127 });
    expect(quazal(config, "sc_bl_secure").ctx.settings.get("storage_host")).toBe("203.0.113.7:8000");
    const online = config.services.find((s) => s.type === "config") as OnlineConfigService;
    expect(onlineConfigContent(online)).toBe(
      '[{"Name":"SandboxUrl","Values":["prudp:/address=203.0.113.7;port=21126"]},{"Name":"SandboxUrlWS","Values":["203.0.113.7:21126"]}]',
    );

    const raw = parseConfig(`services = ["c"]
      [service.c]
      type = "config"
      listen = "0.0.0.0:80"
      content = '[{"Name":"SandboxUrl","Values":["prudp:/address=1.1.1.1;port=21126"]},{"Name":"SandboxUrlWS","Values":["1.1.1.1:21126"]}]'
    `);
    setPublicIp(raw, "10.0.0.2");
    expect(onlineConfigContent(raw.services[0] as OnlineConfigService)).toBe(
      '[{"Name":"SandboxUrl","Values":["prudp:/address=10.0.0.2;port=21126"]},{"Name":"SandboxUrlWS","Values":["10.0.0.2:21126"]}]',
    );
  });
});
