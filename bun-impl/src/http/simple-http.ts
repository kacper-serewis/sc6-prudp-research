/**
 * Minimal HTTP/1.0 responders (port of `simple_http.rs`). Only the request line is read,
 * the response is written and the connection closed.
 */
import { readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "../logger";
import { formatSocketAddress, type SocketAddress } from "../quazal/context";

const IDLE_TIMEOUT_MS = 10_000;

function listen(logger: Logger, address: SocketAddress, onRequestLine: (line: string, socket: Socket) => void) {
  const server = createServer((socket) => {
    let received = "";
    let handled = false;
    const handle = () => {
      if (!handled) {
        handled = true;
        onRequestLine(received, socket);
      }
    };
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      const newline = received.indexOf("\n");
      if (newline >= 0) {
        received = received.slice(0, newline + 1);
        handle();
      }
    });
    socket.on("end", handle);
    socket.on("error", (e) => logger.debug("simple_http: socket error", { error: e.message }));
  });
  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      server.off("error", reject);
      logger.info(`Listening on ${formatSocketAddress(address)}`);
      resolve(server);
    });
  });
}

function respond(socket: Socket, head: string, body: Uint8Array = Buffer.alloc(0)) {
  socket.end(Buffer.concat([Buffer.from(head, "latin1"), body]));
}

const ok = (length: number) =>
  `HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\n\r\n`;

/** Answers every request with `content` (the online configuration). */
export function serveContent(logger: Logger, address: SocketAddress, content: string) {
  const body = Buffer.from(content);
  return listen(logger, address, (line, socket) => {
    logger.debug(`Request: ${line.trim()}`);
    respond(socket, ok(body.length), body);
  });
}

/** Serves `files` (request path -> file path) for `GET <path> HTTP/1.1` requests. */
export function serveFiles(logger: Logger, address: SocketAddress, files: Map<string, string>) {
  return listen(logger, address, (line, socket) => {
    logger.debug(`Request: ${line.trim()}`);
    const prefix = "GET ";
    const suffix = " HTTP/1.1\r\n";
    if (!line.startsWith(prefix)) {
      logger.debug("Status 405");
      return respond(socket, "HTTP/1.0 405 Method Not Allowed\r\n\r\n");
    }
    if (!line.endsWith(suffix)) {
      logger.debug("Status 400");
      return respond(socket, "HTTP/1.0 400 Bad Request\r\n\r\n");
    }
    const file = files.get(line.slice(prefix.length, line.length - suffix.length));
    if (file === undefined) {
      logger.debug("Status 404");
      return respond(socket, "HTTP/1.0 404 Not Found\r\n\r\n");
    }
    readFile(file).then(
      (data) => {
        logger.debug("Status 200");
        respond(socket, ok(data.length), data);
      },
      (e) => {
        logger.error(`simple_http: can't read ${file}`, { error: (e as Error).message });
        respond(socket, "HTTP/1.0 500 Internal Server Error\r\n\r\n");
      },
    );
  });
}
