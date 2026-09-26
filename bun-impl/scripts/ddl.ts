/**
 * Model of the DDL files in `ddl/` (exported from the game with 5th-echelon's DDL parser)
 * and the naming rules of the Rust code generator (`quazal-tools/src/generate.rs`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DdlType =
  | { __class__: "SimpleType"; name: string }
  | { __class__: "TemplateType"; name: string; templ_name: string; parameters: DdlType[] };

interface PType {
  type: DdlType;
}

export interface ClassDeclaration {
  __class__: "ClassDeclaration";
  name1: string;
  namespace: string;
  maybe_base: string;
  variables: { name1: string; type: PType }[];
}

export interface MethodElement {
  __class__: "Parameter" | "ReturnValue";
  name1: string;
  dtype1: PType;
  /** 1 = request, 2 = response, 3 = in/out */
  type: number;
}

export interface ProtocolDeclaration {
  __class__: "ProtocolDeclaration";
  name1: string;
  namespace: string;
  _id?: number;
  methods: { name1: string; elements1: MethodElement[] }[];
}

export interface Namespace {
  name: string;
  file: string;
  classes: ClassDeclaration[];
  protocols: ProtocolDeclaration[];
}

export function loadDdl(dir: string) {
  const namespaces: Namespace[] = [];
  let mapping: Record<string, number> = {};
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const json = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (file === "sc_bl_mapping.json") {
      mapping = json;
      continue;
    }
    const unit = json.elements.find((e: { __class__: string }) => e.__class__ === "DDLUnitDeclaration");
    namespaces.push({
      name: unit.name1,
      file,
      classes: json.elements.filter((e: { __class__: string }) => e.__class__ === "ClassDeclaration"),
      protocols: json.elements.filter((e: { __class__: string }) => e.__class__ === "ProtocolDeclaration"),
    });
  }
  return { namespaces, mapping };
}

/** Protocol id like the Rust generator resolves it: id mapping first, DDL id as fallback. */
export function protocolId(protocol: ProtocolDeclaration, mapping: Record<string, number>): number | undefined {
  return mapping[`${protocol.namespace}::${protocol.name1}`] ?? mapping[protocol.name1] ?? protocol._id;
}

/** Splits identifiers like convert_case does (`URLs` -> `UR`,`Ls`; `Protocol3` -> `Protocol`,`3`). */
export function words(identifier: string): string[] {
  const result: string[] = [];
  for (const segment of identifier.split(/[_\- ]+/).filter(Boolean)) {
    let current = segment[0];
    for (let i = 1; i < segment.length; i++) {
      const [prev, ch, next] = [segment[i - 1], segment[i], segment[i + 1] ?? ""];
      const isUpper = (c: string) => /[A-Z]/.test(c);
      const isLower = (c: string) => /[a-z]/.test(c);
      const isDigit = (c: string) => /[0-9]/.test(c);
      const boundary =
        (isLower(prev) && isUpper(ch)) ||
        (isDigit(prev) !== isDigit(ch) && (isDigit(prev) || isDigit(ch))) ||
        (isUpper(prev) && isUpper(ch) && isLower(next));
      if (boundary) {
        result.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    result.push(current);
  }
  return result;
}

/** Snake case name used by the Rust generator, including its `fix_name` corrections. */
export function rustSnake(identifier: string) {
  return words(identifier)
    .map((w) => w.toLowerCase())
    .join("_")
    .replaceAll("_ur_ls", "_urls")
    .replaceAll("_i_ds", "_ids")
    .replaceAll("_pi_ds", "_pids");
}

export function camel(identifier: string) {
  return rustSnake(identifier)
    .split("_")
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("");
}

export function pascal(identifier: string) {
  const c = camel(identifier);
  return c[0].toUpperCase() + c.slice(1);
}

export function kebab(identifier: string) {
  return words(identifier)
    .map((w) => w.toLowerCase())
    .join("-");
}

/** Field name of a class variable (`m_urlRegularProtocols` -> `urlRegularProtocols`). */
export function fieldName(variable: string) {
  return camel(variable.replace(/^m_/, ""));
}

/** Builtin types, which are not generated from the DDL. */
export const BUILTIN_CLASSES = new Set(["Property", "PropertyVariant", "ResultRange", "Data"]);

/** Classes that exist in several namespaces; references always use the local definition. */
export const NAMESPACE_LOCAL_CLASSES = new Set(["RVConnectionData", "LoginData"]);
