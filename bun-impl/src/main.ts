/**
 * Dedicated server entry point (port of `dedicated_server/src/main.rs`).
 *
 * Usage: bun run src/main.ts [-c service.toml] [--public-ip 1.2.3.4] [--launcher]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import defaultMpBalancing from "../data/mp_balancing.ini" with { type: "text" };
import { startApiServer } from "./api/server";
import { ConfigError, loadConfig, onlineConfigContent, setPublicIp } from "./config";
import { serveContent, serveFiles } from "./http/simple-http";
import { JsonFileSink, Logger, parseLevel, TerminalSink } from "./logger";
import { formatSocketAddress } from "./quazal/context";
import { startQuazalServer } from "./server";
import { Storage } from "./storage/storage";

const USAGE = `Usage: bun run src/main.ts [options]

Options:
  -c, --config <path>    path to the config file (default: service.toml, created if missing)
      --public-ip <ip>   address to advertise to clients instead of the configured ones
      --launcher         started through the launcher: log to server.log.json only and
                         enable the admin API (the key is printed on start)
  -h, --help             show this help

Environment:
  LOG_LEVEL / RUST_LOG   terminal log level (trace, debug, info, warn, error, crit)`;

const DATA_DIR = "data";

/** Makes sure the files served by the default content service exist. */
function ensureDataDir() {
  const mpBalancing = join(DATA_DIR, "mp_balancing.ini");
  if (!existsSync(mpBalancing)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(mpBalancing, defaultMpBalancing);
  }
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      config: { type: "string", short: "c", default: "service.toml" },
      "public-ip": { type: "string" },
      launcher: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const fileSink = new JsonFileSink("server.log.json");
  const logger = args.launcher
    ? new Logger([fileSink])
    : new Logger([new TerminalSink(parseLevel(process.env.LOG_LEVEL ?? process.env.RUST_LOG)), fileSink]);

  process.on("uncaughtException", (e) => logger.crit("Uncaught exception", { error: e }));
  process.on("unhandledRejection", (e) => logger.crit("Unhandled rejection", { error: e }));

  const storage = Storage.open(logger);
  const config = loadConfig(logger, args.config);
  if (args["public-ip"]) {
    setPublicIp(config, args["public-ip"]);
  }
  ensureDataDir();

  logger.warn("Clearing stale sessions");
  storage.invalidateSessions();

  const deps = { storage, dataDir: DATA_DIR };
  const closers: (() => void)[] = [];
  for (const service of config.services) {
    const serviceLogger = logger.child({ service: service.name });
    switch (service.type) {
      case "authentication":
      case "secure": {
        const { ctx } = service;
        serviceLogger.info(`Loaded ${service.type} service`, {
          listen: formatSocketAddress(ctx.listen),
          secure_server_addr: ctx.secureServerAddr && formatSocketAddress(ctx.secureServerAddr),
        });
        const { server } = await startQuazalServer(serviceLogger, ctx, deps, service.type === "secure");
        closers.push(() => server.close());
        break;
      }
      case "config": {
        if (service.listen.port !== 80) {
          serviceLogger.warn(
            `Unexpected port ${service.listen.port} used for the config server. Clients are expecting port 80. ` +
              "Adjust in the service config or make sure to redirect traffic accordingly",
          );
        }
        const server = await serveContent(serviceLogger, service.listen, onlineConfigContent(service));
        closers.push(() => server.close());
        break;
      }
      case "content": {
        const server = await serveFiles(serviceLogger, service.listen, service.files);
        closers.push(() => server.close());
        break;
      }
    }
  }

  const api = await startApiServer({
    logger: logger.child({ service: "api" }),
    storage,
    address: config.apiServer,
    debug: config.debug,
    enableAdminServices: args.launcher,
    onAdminKey: (key) => console.log(`Admin Key: ${key}`),
  });
  closers.push(() => api.server.forceShutdown());

  const shutdown = () => {
    logger.info("Shutting down");
    closers.forEach((close) => close());
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? `Invalid configuration: ${e.message}` : e);
  process.exit(1);
});
