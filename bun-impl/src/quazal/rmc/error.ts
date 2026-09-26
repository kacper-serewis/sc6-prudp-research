/** Errors an RMC method can fail with (port of `quazal::rmc::Error`). */
export enum RmcErrorKind {
  MissingData = "MissingData",
  ParsingError = "ParsingError",
  UnknownProtocol = "UnknownProtocol",
  UnknownMethod = "UnknownMethod",
  UnimplementedMethod = "UnimplementedMethod",
  InvalidPacketType = "InvalidPacketType",
  InternalError = "InternalError",
  AccessDenied = "AccessDenied",
}

// https://github.com/kinnay/NintendoClients/blob/13a5bdc3723bcc6cd5d0c8bb106250efbce7c165/nintendo/nex/errors.py
const ERROR_CODES: Record<RmcErrorKind, number> = {
  [RmcErrorKind.UnknownProtocol]: 0x0001_0001,
  [RmcErrorKind.UnknownMethod]: 0x0001_0001,
  [RmcErrorKind.UnimplementedMethod]: 0x0001_0002,
  [RmcErrorKind.AccessDenied]: 0x0001_0006,
  [RmcErrorKind.MissingData]: 0x0001_0009,
  [RmcErrorKind.ParsingError]: 0x0001_000a,
  [RmcErrorKind.InvalidPacketType]: 0x0001_000a,
  [RmcErrorKind.InternalError]: 0x0001_0012,
};

const KINDS_BY_CODE = new Map<number, RmcErrorKind>([
  [0x0001_0001, RmcErrorKind.UnknownProtocol],
  [0x0001_0002, RmcErrorKind.UnimplementedMethod],
  [0x0001_0006, RmcErrorKind.AccessDenied],
  [0x0001_0009, RmcErrorKind.MissingData],
  [0x0001_000a, RmcErrorKind.ParsingError],
  [0x0001_0012, RmcErrorKind.InternalError],
]);

export class RmcError extends Error {
  override name = "RmcError";

  constructor(
    readonly kind: RmcErrorKind,
    message?: string,
  ) {
    super(message ? `${kind}: ${message}` : kind);
  }

  /** The error code sent to the client. */
  get errorCode() {
    return (ERROR_CODES[this.kind] | 0x8000_0000) >>> 0;
  }

  static fromErrorCode(code: number): RmcError | undefined {
    if (!(code & 0x8000_0000)) {
      return undefined;
    }
    const kind = KINDS_BY_CODE.get(code & 0x7fff_ffff);
    return kind && new RmcError(kind);
  }
}
