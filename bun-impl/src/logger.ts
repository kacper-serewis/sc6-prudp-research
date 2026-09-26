/**
 * Minimal structured logger modelled after the `slog` setup of the Rust server:
 * leveled records with inherited key/value context, printed to the terminal and
 * optionally appended to a JSON lines file.
 */
import chalk from "chalk";
import { existsSync, renameSync } from "node:fs";

export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, crit: 60 } as const;
export type Level = keyof typeof LEVELS;

export type LogContext = Record<string, unknown>;

export interface LogRecord {
  time: Date;
  level: Level;
  msg: string;
  context: LogContext;
}

export interface LogSink {
  readonly minLevel: number;
  write(record: LogRecord): void;
}

export class Logger {
  private readonly minLevel: number;

  constructor(
    private readonly sinks: LogSink[],
    private readonly context: LogContext = {},
  ) {
    this.minLevel = Math.min(...sinks.map((s) => s.minLevel), LEVELS.crit + 1);
  }

  /** A logger that adds `context` to every record. */
  child(context: LogContext) {
    return new Logger(this.sinks, { ...this.context, ...context });
  }

  enabled(level: Level) {
    return LEVELS[level] >= this.minLevel;
  }

  log(level: Level, msg: string, context?: LogContext) {
    if (!this.enabled(level)) {
      return;
    }
    const record = { time: new Date(), level, msg, context: context ? { ...this.context, ...context } : this.context };
    for (const sink of this.sinks) {
      if (LEVELS[level] >= sink.minLevel) {
        sink.write(record);
      }
    }
  }

  trace(msg: string, context?: LogContext) {
    this.log("trace", msg, context);
  }
  debug(msg: string, context?: LogContext) {
    this.log("debug", msg, context);
  }
  info(msg: string, context?: LogContext) {
    this.log("info", msg, context);
  }
  warn(msg: string, context?: LogContext) {
    this.log("warn", msg, context);
  }
  error(msg: string, context?: LogContext) {
    this.log("error", msg, context);
  }
  crit(msg: string, context?: LogContext) {
    this.log("crit", msg, context);
  }
}

/** Accepts the level names of `RUST_LOG` as used by the Rust server. */
export function parseLevel(value: string | undefined, fallback: Level = "info"): Level {
  switch (value?.toLowerCase()) {
    case "trace":
      return "trace";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "crit":
    case "critical":
      return "crit";
    default:
      return fallback;
  }
}

function formatValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "None";
  }
  return inspect(value);
}

function inspect(value: unknown) {
  return Bun.inspect(value, { depth: 6, colors: false }).replace(/\s*\n\s*/g, " ");
}

const LEVEL_STYLE: Record<Level, (s: string) => string> = {
  trace: chalk.gray,
  debug: chalk.cyan,
  info: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
  crit: chalk.bgRed.white,
};

export class TerminalSink implements LogSink {
  readonly minLevel: number;

  constructor(level: Level, private readonly out: (line: string) => void = (line) => console.error(line)) {
    this.minLevel = LEVELS[level];
  }

  write({ time, level, msg, context }: LogRecord) {
    const ts = chalk.dim(time.toISOString().slice(11, 23));
    const lvl = LEVEL_STYLE[level](level.toUpperCase().padEnd(5));
    const ctx = Object.entries(context)
      .map(([k, v]) => `${chalk.dim(k)}=${formatValue(v)}`)
      .join(" ");
    this.out(`${ts} ${lvl} ${msg}${ctx ? `  ${ctx}` : ""}`);
  }
}

/** Appends JSON lines to a file, similar to the `server.log.json` of the Rust server. */
export class JsonFileSink implements LogSink {
  readonly minLevel: number;
  private readonly writer;

  constructor(path: string, level: Level = "trace") {
    this.minLevel = LEVELS[level];
    rotateLogFiles(path);
    this.writer = Bun.file(path).writer();
  }

  write({ time, level, msg, context }: LogRecord) {
    const entry: Record<string, unknown> = { msg, level: level.toUpperCase(), ts: time.toISOString() };
    for (const [k, v] of Object.entries(context)) {
      entry[k] = typeof v === "bigint" || v instanceof Error || typeof v === "object" ? formatValue(v) : v;
    }
    this.writer.write(JSON.stringify(entry) + "\n");
    this.writer.flush();
  }
}

/** Keeps up to 10 old log files (`server.log.json.1` ... `server.log.json.10`). */
function rotateLogFiles(path: string) {
  for (let i = 9; i >= 1; i--) {
    if (existsSync(`${path}.${i}`)) {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
  }
  if (existsSync(path)) {
    renameSync(path, `${path}.1`);
  }
}

/** A logger without output, e.g. for tests. */
export const silentLogger = new Logger([]);
