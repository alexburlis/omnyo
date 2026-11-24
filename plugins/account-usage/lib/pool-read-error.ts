import { isIP } from "node:net";
import { z } from "zod";

const socketSchema = z.object({
  localAddress: z.string().optional(),
  localPort: z.number().optional(),
  remoteAddress: z.string().optional(),
  remotePort: z.number().optional(),
  bytesRead: z.number().optional(),
  bytesWritten: z.number().optional(),
});

const sourceSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  errno: z.union([z.string(), z.number()]).optional(),
  syscall: z.string().optional(),
  address: z.string().optional(),
  port: z.number().optional(),
  stack: z.string().optional(),
  cause: z.unknown().optional(),
  errors: z.unknown().optional(),
  socket: socketSchema.nullable().optional(),
});

const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "SystemError",
  "SocketError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "OmnyoHttpError",
  "OmnyoRequestTimeoutError",
  "BbHttpError",
  "BbRequestTimeoutError",
  "ZodError",
]);

const TRANSPORT_MESSAGES = new Set([
  "fetch failed",
  "other side closed",
  "terminated",
  "aborted",
  "This operation was aborted",
  "The operation was aborted.",
  "The operation was aborted due to timeout",
]);

function networkAddress(value: string | undefined): string | null {
  return value !== undefined && isIP(value) !== 0 ? value : null;
}

function networkPort(value: number | undefined): number | null {
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 65535
    ? value
    : null;
}

function byteCount(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function describeSocket(
  socket: z.infer<typeof socketSchema> | null | undefined,
) {
  return socket == null
    ? null
    : {
        localAddress: networkAddress(socket.localAddress),
        localPort: networkPort(socket.localPort),
        remoteAddress: networkAddress(socket.remoteAddress),
        remotePort: networkPort(socket.remotePort),
        bytesRead: byteCount(socket.bytesRead),
        bytesWritten: byteCount(socket.bytesWritten),
      };
}

interface ErrorDiagnostic {
  name: string;
  message: string | null;
  code: string | number | null;
  errno: string | number | null;
  syscall: string | null;
  address: string | null;
  port: number | null;
  frames: string[];
  socket: ReturnType<typeof describeSocket>;
  cause: ErrorDiagnostic | null;
  errors: ErrorDiagnostic[];
}

function technicalCode(
  value: string | number | undefined,
): string | number | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? value : null;

  return value !== undefined &&
    /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|ABORT_ERR|TIMEOUT_ERR)$/.test(
      value,
    ) &&
    value.length <= 80
    ? value
    : null;
}

export function describePoolReadError(error: unknown): ErrorDiagnostic | null {
  const seen = new Set<object>();
  let remaining = 16;

  const visit = (value: unknown, depth: number): ErrorDiagnostic | null => {
    if (
      typeof value !== "object" ||
      value === null ||
      seen.has(value) ||
      depth >= 5 ||
      remaining === 0
    )
      return null;
    seen.add(value);
    remaining -= 1;
    const parsed = sourceSchema.safeParse(value);

    if (!parsed.success) return null;
    const source = parsed.data;
    const code = technicalCode(source.code);

    const syscall =
      source.syscall !== undefined &&
      /^(?:connect|read|write|listen|accept|send|recv|sendto|recvfrom|getaddrinfo|getnameinfo)$/.test(
        source.syscall,
      )
        ? source.syscall
        : null;

    const address = networkAddress(source.address);
    const port = networkPort(source.port);

    const frames = (source.stack ?? "")
      .split("\n")
      .slice(1, 9)
      .flatMap((line) => {
        const match = line.match(/\b(node:[a-z0-9_./-]+:\d+:\d+)\)?$/i);

        return match === null ? [] : [match[1]];
      });

    const errors: ErrorDiagnostic[] = [];

    if (Array.isArray(source.errors)) {
      for (const item of source.errors.slice(0, 4)) {
        const diagnostic = visit(item, depth + 1);

        if (diagnostic !== null) errors.push(diagnostic);
      }
    }

    return {
      name:
        source.name !== undefined && ERROR_NAMES.has(source.name)
          ? source.name
          : "Error",
      message:
        source.message !== undefined && TRANSPORT_MESSAGES.has(source.message)
          ? source.message
          : typeof code === "string" && syscall !== null
            ? `${syscall} ${code}${address === null ? "" : ` ${address}${port === null ? "" : `:${port}`}`}`
            : null,
      code,
      errno: technicalCode(source.errno),
      syscall,
      address,
      port,
      frames,
      socket: describeSocket(source.socket),
      cause: visit(source.cause, depth + 1),
      errors,
    };
  };

  return visit(error, 0);
}
