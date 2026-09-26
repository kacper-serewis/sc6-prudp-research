/**
 * `service.toml` handling. The format is the one of the Rust server (`quazal::Config` and
 * `dedicated_server_config::Config`), so existing configuration files keep working.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Logger } from "./logger";
import {
  formatSocketAddress,
  parseSocketAddress,
  TICKET_KEY_SIZE,
  type Context,
  type SocketAddress,
} from "./quazal/context";

export interface QuazalService {
  name: string;
  type: "authentication" | "secure";
  ctx: Context;
}

export interface OnlineConfigItem {
  name: string;
  values: string[];
}

/** HTTP service with the online configuration the game fetches on start (expected on port 80). */
export interface OnlineConfigService {
  name: string;
  type: "config";
  listen: SocketAddress;
  content: { type: "raw"; value: string } | { type: "typed"; items: OnlineConfigItem[] };
}

/** HTTP service for static files (e.g. `mp_balancing.ini`). */
export interface ContentService {
  name: string;
  type: "content";
  listen: SocketAddress;
  /** Request path -> file path. */
  files: Map<string, string>;
}

export type Service = QuazalService | OnlineConfigService | ContentService;

export interface DebugConfig {
  markAllAsOnline: boolean;
  forceJoins: boolean;
}

export interface Config {
  /** Enabled services, in the order of the `services` list. */
  services: Service[];
  apiServer: SocketAddress;
  debug: DebugConfig;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(value: unknown, what: string): Buffer {
  if (typeof value === "string") {
    return Buffer.from(value);
  }
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Buffer.from(value as number[]);
  }
  throw new ConfigError(`${what} must be a string or a byte array`);
}

function address(value: unknown, what: string): SocketAddress {
  if (typeof value !== "string") {
    throw new ConfigError(`${what} must be an address like "0.0.0.0:21126"`);
  }
  try {
    return parseSocketAddress(value);
  } catch (e) {
    throw new ConfigError(`${what}: ${(e as Error).message}`);
  }
}

function stringMap(value: unknown, what: string) {
  if (value === undefined) {
    return new Map<string, string>();
  }
  if (!isTable(value) || !Object.values(value).every((v) => typeof v === "string")) {
    throw new ConfigError(`${what} must be a table of strings`);
  }
  return new Map(Object.entries(value as Record<string, string>));
}

function parseContext(table: Table, name: string, sharedTicketKey: () => Buffer): Context {
  let ticketKey: Buffer;
  if (table.ticket_key === undefined) {
    ticketKey = sharedTicketKey();
  } else {
    ticketKey = bytes(table.ticket_key, `service.${name}.ticket_key`);
    if (ticketKey.length !== TICKET_KEY_SIZE) {
      throw new ConfigError(`service.${name}.ticket_key must have ${TICKET_KEY_SIZE} bytes`);
    }
  }
  const vport = table.vport ?? 1;
  if (!Number.isInteger(vport) || (vport as number) < 0 || (vport as number) > 15) {
    throw new ConfigError(`service.${name}.vport must be a number between 0 and 15`);
  }
  return {
    accessKey: table.access_key === undefined ? Buffer.alloc(0) : bytes(table.access_key, `service.${name}.access_key`),
    cryptoKey: table.crypto_key === undefined ? Buffer.from("CD&ML") : bytes(table.crypto_key, `service.${name}.crypto_key`),
    listen: table.listen === undefined ? { host: "0.0.0.0", port: 9999 } : address(table.listen, `service.${name}.listen`),
    vport: vport as number,
    secureServerAddr:
      table.secure_server_addr === undefined ? undefined : address(table.secure_server_addr, `service.${name}.secure_server_addr`),
    settings: stringMap(table.settings, `service.${name}.settings`),
    ticketKey,
  };
}

function parseService(name: string, table: Table, sharedTicketKey: () => Buffer): Service {
  switch (table.type) {
    case "authentication":
    case "secure":
      return { name, type: table.type, ctx: parseContext(table, name, sharedTicketKey) };
    case undefined: {
      // Like the Rust server: services without a type are authentication services if they
      // point to a secure server.
      const ctx = parseContext(table, name, sharedTicketKey);
      return { name, type: ctx.secureServerAddr ? "authentication" : "secure", ctx };
    }
    case "config": {
      const content = table.content;
      let parsed: OnlineConfigService["content"];
      if (typeof content === "string") {
        parsed = { type: "raw", value: content };
      } else if (Array.isArray(content) && content.every((item) => isTable(item))) {
        parsed = {
          type: "typed",
          items: (content as Table[]).map((item, i) => {
            if (typeof item.Name !== "string" || !Array.isArray(item.Values) || !item.Values.every((v) => typeof v === "string")) {
              throw new ConfigError(`service.${name}.content[${i}] needs a Name and a list of Values`);
            }
            return { name: item.Name, values: item.Values as string[] };
          }),
        };
      } else {
        throw new ConfigError(`service.${name}.content must be a string or a list of { Name, Values }`);
      }
      return { name, type: "config", listen: address(table.listen, `service.${name}.listen`), content: parsed };
    }
    case "content":
      return {
        name,
        type: "content",
        listen: address(table.listen, `service.${name}.listen`),
        files: stringMap(table.files, `service.${name}.files`),
      };
    default:
      throw new ConfigError(`service.${name}.type "${String(table.type)}" is unknown`);
  }
}

export function parseConfig(text: string): Config {
  let root: Table;
  try {
    root = Bun.TOML.parse(text) as Table;
  } catch (e) {
    throw new ConfigError(`invalid TOML: ${(e as Error).message}`);
  }
  const enabled = root.services;
  if (!Array.isArray(enabled) || !enabled.every((s) => typeof s === "string")) {
    throw new ConfigError("services must be a list of service names");
  }
  const definitions = isTable(root.service) ? root.service : {};

  // Services without an explicit ticket key share one, so tickets from the authentication
  // service can be opened by the secure service.
  let generatedKey: Buffer | undefined;
  const sharedTicketKey = () => (generatedKey ??= randomBytes(TICKET_KEY_SIZE));

  const missing = enabled.filter((name) => !isTable(definitions[name]));
  if (missing.length) {
    throw new ConfigError(`Service ${missing.join("/")} not found`);
  }
  const services = [...new Set(enabled as string[])].map((name) =>
    parseService(name, definitions[name] as Table, sharedTicketKey),
  );

  const debug = isTable(root.debug) ? root.debug : {};
  return {
    services,
    apiServer: root.api_server === undefined ? { host: "0.0.0.0", port: 50051 } : address(root.api_server, "api_server"),
    debug: { markAllAsOnline: debug.mark_all_as_online === true, forceJoins: debug.force_joins === true },
  };
}

/** The configuration the Rust server generates on its first start, with a fresh ticket key. */
export function defaultConfigToml(ticketKey = randomBytes(TICKET_KEY_SIZE)) {
  const key = `[${[...ticketKey].join(", ")}]`;
  return `# Server configuration, same format as the service.toml of the Rust 5th-echelon server.
# Replace 127.0.0.1 with the server's public address to let other machines connect
# (or start the server with --public-ip).
services = ["onlineconfig", "content", "sc_bl_secure", "sc_bl_auth"]
api_server = "0.0.0.0:50051"

[debug]
mark_all_as_online = false
force_joins = false

[service.sc_bl_auth]
type = "authentication"
access_key = "yl4NG7qZ"
crypto_key = "CD&ML"
listen = "0.0.0.0:21126"
vport = 1
secure_server_addr = "127.0.0.1:21127"
ticket_key = ${key}

[service.sc_bl_auth.settings]

[service.sc_bl_secure]
type = "secure"
access_key = "yl4NG7qZ"
crypto_key = "CD&ML"
listen = "0.0.0.0:21127"
vport = 1
ticket_key = ${key}

[service.sc_bl_secure.settings]
storage_host = "127.0.0.1:8000"
storage_path = "/mp_balancing.ini"

[service.onlineconfig]
type = "config"
listen = "0.0.0.0:80"

[[service.onlineconfig.content]]
Name = "SandboxUrl"
Values = ["prudp:/address=127.0.0.1;port=21126"]

[[service.onlineconfig.content]]
Name = "SandboxUrlWS"
Values = ["127.0.0.1:21126"]

[service.content]
type = "content"
listen = "0.0.0.0:8000"

[service.content.files]
"/mp_balancing.ini" = "./data/mp_balancing.ini"
`;
}

/** Loads the configuration, writing the default one first if the file does not exist. */
export function loadConfig(logger: Logger, path: string): Config {
  if (!existsSync(path)) {
    logger.error(`Couldn't load service file ${path}, generating default`);
    const text = defaultConfigToml();
    try {
      writeFileSync(path, text);
    } catch (e) {
      logger.error("Couldn't save service file", { error: (e as Error).message });
    }
    return parseConfig(text);
  }
  return parseConfig(readFileSync(path, "utf8"));
}

/** Rendered online configuration, as JSON for typed content. */
export function onlineConfigContent(service: OnlineConfigService) {
  if (service.content.type === "raw") {
    return service.content.value;
  }
  return JSON.stringify(service.content.items.map((item) => ({ Name: item.name, Values: item.values })));
}

/**
 * Advertises `ip` instead of the configured addresses: the secure server address handed out
 * at login, the content host, and the sandbox URLs of the online configuration.
 */
export function setPublicIp(config: Config, ip: string) {
  for (const service of config.services) {
    if (service.type === "authentication" && service.ctx.secureServerAddr) {
      service.ctx.secureServerAddr = { ...service.ctx.secureServerAddr, host: ip };
    }
    if (service.type === "secure") {
      const host = service.ctx.settings.get("storage_host");
      if (host) {
        const { port } = parseSocketAddress(host);
        service.ctx.settings.set("storage_host", formatSocketAddress({ host: ip, port }));
      }
    }
    if (service.type === "config") {
      if (service.content.type === "raw") {
        service.content.value = service.content.value
          .replace(/("Name":"SandboxUrl",.*?address=)[^;"]*/, `$1${ip}`)
          .replace(/("Name":"SandboxUrlWS","Values":\[")[^:"\]]*/, `$1${ip}`);
      } else {
        for (const item of service.content.items) {
          if (item.name === "SandboxUrl") {
            item.values = item.values.map((v) => v.replace(/address=[^;]*/, `address=${ip}`));
          }
          if (item.name === "SandboxUrlWS") {
            item.values = item.values.map((v) => {
              try {
                return formatSocketAddress({ host: ip, port: parseSocketAddress(v).port });
              } catch {
                return v;
              }
            });
          }
        }
      }
    }
  }
}
