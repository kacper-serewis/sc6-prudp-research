/**
 * Overlord protocols (ports of `overlord_core.rs`, `overlord_news.rs` and `overlord_challenge.rs`).
 *
 * They are not part of the game's DDL, so their types were reverse engineered upstream and
 * are defined here by hand. Field names follow the Rust code, including the unknown ones.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as c from "../quazal/codec";
import type { StreamCall } from "../quazal/prudp/server";
import { RmcError, RmcErrorKind } from "../quazal/rmc/error";
import { decodeParameters, loginRequired, type Protocol } from "../quazal/rmc/protocol";
import { dateTime, variant, Variant } from "../quazal/types";
import type { ServiceDeps } from "./deps";

function handMadeProtocol(
  id: number,
  name: string,
  numMethods: number,
  methodNames: Record<number, string>,
  handle: Protocol["handle"],
): Protocol {
  return { id, name, numMethods, methodName: (methodId) => methodNames[methodId], handle };
}

const unknownMethod = () => new RmcError(RmcErrorKind.UnknownMethod);

const ConfigEntry = c.struct({ name: c.string, value: variant });

/** Settings the game reads on start (`fetch_config`). Names without meaning are hashes. */
const CORE_CONFIG: [string, Variant][] = [
  ["VER_SERVER_STAGE", Variant.i64(10)],
  ["2593515025", Variant.i64(1)],
  ["2626349757", Variant.i64(1)],
  ["NC_CONNECTION_TICKET_TIMEOUT", Variant.f64(10.0)],
  ["NC_CONNECTION_HANDSHAKING_TIMEOUT", Variant.f64(5.0)],
  ["314486871", Variant.i64(1)],
  ["3759634546", Variant.i64(1)],
  ["NC_MAIN_PORT_RANGE", Variant.i64(32)],
  ["2449304206", Variant.i64(1)],
  ["OVERLORD_VERSION", Variant.string("0.8.0.0")],
  ["2685611256", Variant.i64(1)],
  ["3376331533", Variant.i64(1)],
  ["VER_SERVER_CODE", Variant.i64(3007)],
  ["FILESERVICE_UNLOCKS_UPLOAD_ENABLED", Variant.i64(1)],
  ["2739184075", Variant.i64(1)],
  ["2942435614", Variant.i64(1)],
  ["SN_FRIENDCHALLENGES_MAX_READ_INTERVAL", Variant.f64(900.0)],
  ["NC_CONNECTION_JOIN_TIMEOUT", Variant.f64(15.0)],
  ["1027449109", Variant.i64(1)],
  ["4175756708", Variant.i64(1)],
  ["NC_CONNECTION_INACTIVITY_THRESHOLD", Variant.f64(8.0)],
  ["FILESERVICE_ADMIN_RDVID", Variant.i64(1119)],
  ["SN_WEEKLYCHALLENGES_ENABLE", Variant.i64(1)],
  ["1597953054", Variant.i64(1)],
  ["2156388390", Variant.i64(1)],
  ["3785106560", Variant.i64(1)],
  ["STATS_WRITE_INTERVAL", Variant.f64(1.0)],
  ["3835530207", Variant.i64(1)],
  ["1492891464", Variant.i64(1)],
  ["SN_DAILYCHALLENGES_ENABLE", Variant.i64(1)],
  ["2505766166", Variant.i64(1)],
  ["11866509", Variant.i64(1)],
  ["SN_FRIENDCHALLENGES_ENABLE", Variant.i64(1)],
  ["FILESERVICE_UNLOCKS_UPLOAD_INTERVAL", Variant.f64(3600.0)],
  ["2524360986", Variant.i64(1)],
  ["721797971", Variant.i64(1)],
  ["1525666223", Variant.i64(1)],
  ["COMMUNITYEVENT_DOUBLECASH", Variant.i64(0)],
  ["UPLAY_MAX_RANK_LIMITED_MODE", Variant.i64(5)],
  ["SN_GONEDARKCHALLENGES_ENABLE", Variant.i64(1)],
  ["_OSDK_VERSION", Variant.string("1.4.16.32918")],
  ["NC_MAIN_PORT", Variant.i64(13000)],
  ["COMMUNITYEVENT_DOUBLEXP", Variant.i64(0)],
  ["3804368594", Variant.i64(1)],
  ["NC_CONNECTION_CLOSING_TIMEOUT", Variant.f64(2.0)],
  ["NC_CONNECTION_ESTABLISHED_TIMEOUT", Variant.f64(10.0)],
];

export function overlordCoreProtocol() {
  return handMadeProtocol(5003, "OverlordCoreProtocol", 1, { 1: "fetch_config" }, (call, request) => {
    loginRequired(call);
    if (request.methodId !== 1) {
      throw unknownMethod();
    }
    return c.encode(
      c.list(ConfigEntry),
      CORE_CONFIG.map(([name, value]) => ({ name, value })),
    );
  });
}

// -- JSON data files -----------------------------------------------------------------------------

type Json = null | boolean | number | bigint | string | Json[] | { [key: string]: Json };

/** JSON.parse that keeps large integers (like `u64::MAX` timestamps) exact as bigints. */
export function parseJson(text: string): Json {
  const quoted = text.replace(/("(?:[^"\\]|\\.)*")|(?<![\w.])(-?\d{16,})(?![\w.])/g, (match, str) =>
    str ? match : `"\\u0000big:${match}"`,
  );
  return JSON.parse(quoted, (_key, value) =>
    typeof value === "string" && value.startsWith("\u0000big:") ? BigInt(value.slice(5)) : value,
  );
}

class JsonShapeError extends Error {}

function field(obj: Json, name: string): Json {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj) || !(name in obj)) {
    throw new JsonShapeError(`missing field ${name}`);
  }
  return obj[name];
}

function u32Field(obj: Json, name: string) {
  const value = field(obj, name);
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new JsonShapeError(`${name} must be a u32`);
  }
  return n;
}

function u64Field(obj: Json, name: string) {
  const value = field(obj, name);
  if ((typeof value === "number" && Number.isInteger(value) && value >= 0) || typeof value === "bigint") {
    const n = BigInt(value);
    if (n <= 0xffff_ffff_ffff_ffffn) {
      return n;
    }
  }
  throw new JsonShapeError(`${name} must be a u64`);
}

function stringField(obj: Json, name: string) {
  const value = field(obj, name);
  if (typeof value !== "string") {
    throw new JsonShapeError(`${name} must be a string`);
  }
  return value;
}

function boolField(obj: Json, name: string) {
  const value = field(obj, name);
  if (typeof value !== "boolean") {
    throw new JsonShapeError(`${name} must be a bool`);
  }
  return value;
}

/** A `Variant` in serde's external tagging: `"None"` or `{"I64": 1}`, `{"String": "x"}`, ... */
function variantFromJson(value: Json): Variant {
  if (value === "None") {
    return Variant.none();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [tag, inner] = entries[0];
      const int = typeof inner === "bigint" || (typeof inner === "number" && Number.isInteger(inner));
      switch (tag) {
        case "I64":
          if (int) return Variant.i64(inner as number | bigint);
          break;
        case "U64":
          if (int) return Variant.u64(inner as number | bigint);
          break;
        case "DateTime":
          if (int) return Variant.datetime(inner as number | bigint);
          break;
        case "F64":
          if (typeof inner === "number" || typeof inner === "bigint") return Variant.f64(Number(inner));
          break;
        case "Bool":
          if (typeof inner === "boolean") return Variant.bool(inner);
          break;
        case "String":
          if (typeof inner === "string") return Variant.string(inner);
          break;
      }
    }
  }
  throw new JsonShapeError(`invalid variant ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
}

function variantMapField(obj: Json, name: string) {
  const value = field(obj, name);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonShapeError(`${name} must be a map`);
  }
  return new Map(Object.entries(value).map(([k, v]) => [k, variantFromJson(v)]));
}

/**
 * Reads `dataDir/file` as a JSON array. Like the Rust server, a missing or malformed file
 * results in the built-in default.
 */
function loadList<T>(call: StreamCall, path: string, item: (json: Json) => T, fallback: () => T[]): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return fallback();
  }
  try {
    const json = parseJson(text);
    if (!Array.isArray(json)) {
      throw new JsonShapeError("expected an array");
    }
    return json.map(item);
  } catch (e) {
    call.logger.warn(`Ignoring ${path}: ${(e as Error).message}`);
    return fallback();
  }
}

// -- News ----------------------------------------------------------------------------------------

export const NewsItem = c.struct({
  maybeId: c.u32,
  unk2: c.u32,
  unk3: c.u32,
  unk4: c.u32,
  unk5: c.string,
  unk6: dateTime,
  unk7: dateTime,
  expirationTime: dateTime,
  title: c.string,
  link: c.string,
  description: c.string,
});
export type NewsItem = c.Infer<typeof NewsItem>;

const newsFromJson = (json: Json): NewsItem => ({
  maybeId: u32Field(json, "maybe_id"),
  unk2: u32Field(json, "unk2"),
  unk3: u32Field(json, "unk3"),
  unk4: u32Field(json, "unk4"),
  unk5: stringField(json, "unk5"),
  unk6: u64Field(json, "unk6"),
  unk7: u64Field(json, "unk7"),
  expirationTime: u64Field(json, "expiration_time"),
  title: stringField(json, "title"),
  link: stringField(json, "link"),
  description: stringField(json, "description"),
});

const DEFAULT_NEWS = (): NewsItem[] => [
  {
    maybeId: 195389,
    unk2: 9,
    unk3: 2,
    unk4: 2,
    unk5: "Quazal Rendez-Vous",
    unk6: 0n,
    unk7: 0n,
    expirationTime: 0n,
    title: "WELCOME BACK!",
    link: "https://github.com/unixoide/5th-echelon",
    description: "5th Echelon is here!",
  },
];

export function overlordNewsProtocol({ dataDir }: ServiceDeps) {
  return handMadeProtocol(5002, "OverlordNewsProtocol", 2, { 1: "get_news" }, (call, request) => {
    loginRequired(call);
    if (request.methodId === 2) {
      call.logger.error("not implemented yet");
    }
    if (request.methodId !== 1) {
      throw unknownMethod();
    }
    const news = loadList(call, join(dataDir, "news.json"), newsFromJson, DEFAULT_NEWS);
    return c.encode(c.list(NewsItem), news);
  });
}

// -- Challenges ----------------------------------------------------------------------------------

const GetChallengesRequest = c.struct({ class: c.string });

const variantMap = c.map(c.string, variant);

export const Challenge = c.struct({
  unk1: c.u32,
  unk2: c.string,
  someXml: c.string,
  unk4: c.u32,
  unk5: c.u32,
  unk6: c.u32,
  unk7: c.u32,
  unk8: c.bool,
  unk9: dateTime,
  unk10: dateTime,
  unk11: c.string,
  unk12: c.string,
  unk13: c.string,
  unk14: variantMap,
  unk15: variantMap,
  unk16: variantMap,
  unk17: c.u32,
  unk18: dateTime,
  unk19: variantMap,
});
export type Challenge = c.Infer<typeof Challenge>;

export const GetChallengesResponse = c.struct({ challenges: c.list(Challenge) });

const challengeFromJson = (json: Json): Challenge => ({
  unk1: u32Field(json, "unk1"),
  unk2: stringField(json, "unk2"),
  someXml: stringField(json, "some_xml"),
  unk4: u32Field(json, "unk4"),
  unk5: u32Field(json, "unk5"),
  unk6: u32Field(json, "unk6"),
  unk7: u32Field(json, "unk7"),
  unk8: boolField(json, "unk8"),
  unk9: u64Field(json, "unk9"),
  unk10: u64Field(json, "unk10"),
  unk11: stringField(json, "unk11"),
  unk12: stringField(json, "unk12"),
  unk13: stringField(json, "unk13"),
  unk14: variantMapField(json, "unk14"),
  unk15: variantMapField(json, "unk15"),
  unk16: variantMapField(json, "unk16"),
  unk17: u32Field(json, "unk17"),
  unk18: u64Field(json, "unk18"),
  unk19: variantMapField(json, "unk19"),
});

const FOREVER = 0xffff_ffff_ffff_ffffn;

const DEFAULT_CHALLENGES = (): Challenge[] => [
  {
    unk1: 160200,
    unk2: "{}",
    someXml:
      '<Challenge Name="LocID_SNN_ReminderGoneDark_20" Desc="LocID_SNDES_ReminderGoneDark_20" Guid="160200" ShortDesc="LocID_SNSD_ReminderGoneDark_20" ' +
      'Category="OnlineChallengeGoneDarkHeader">' +
      '<GoneDark id="160200" PosX="262" PosY="397" Resource="GD_Grim_004" title="LocID_C_INT_20_Title" loc="LocID_C_INT_20_Loc_0" desc="LocID_C_INT_20_Desc_1" />' +
      "<Definition>" +
      "<GameEvent>" +
      "<Event>" +
      "<GoneDarkUI>" +
      '<ID Op="Equal" Value="160200" />' +
      "</GoneDarkUI>" +
      "</Event>" +
      "</GameEvent>" +
      "</Definition>" +
      '<StepReward Count="123">' +
      "<UnlockChallenge>" +
      '<ID val="160201" />' +
      "</UnlockChallenge>" +
      "</StepReward>" +
      "</Challenge>",
    unk4: 0,
    unk5: 0,
    unk6: 0,
    unk7: 1,
    unk8: false,
    unk9: 0n,
    unk10: FOREVER,
    unk11: "{}",
    unk12: "{}",
    unk13: "{}",
    unk14: new Map(),
    unk15: new Map([
      ["s", Variant.i64(1)],
      ["p", Variant.i64(123)],
    ]),
    unk16: new Map(),
    unk17: 2,
    unk18: FOREVER,
    unk19: new Map(),
  },
];

export function overlordChallengeProtocol({ dataDir }: ServiceDeps) {
  return handMadeProtocol(5007, "OverlordChallengeProtocol", 6, { 1: "get_challenges" }, (call, request) => {
    loginRequired(call);
    if (request.methodId >= 2 && request.methodId <= 6) {
      call.logger.error("not implemented yet");
    }
    if (request.methodId !== 1) {
      throw unknownMethod();
    }
    decodeParameters(GetChallengesRequest, request.parameters);
    const challenges = loadList(call, join(dataDir, "challenges.json"), challengeFromJson, DEFAULT_CHALLENGES);
    return c.encode(GetChallengesResponse, { challenges });
  });
}
