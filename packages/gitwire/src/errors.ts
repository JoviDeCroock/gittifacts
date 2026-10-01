/** Base class for every error thrown by @app/gitwire. */
export class GitWireError extends Error {
  override name = "GitWireError";
}

/** The HTTP layer failed (non-2xx, or a response with an unexpected Content-Type). */
export class GitHttpError extends GitWireError {
  override name = "GitHttpError";
  constructor(
    readonly status: number,
    message: string,
    readonly body = "",
  ) {
    super(message);
  }
}

/** The server spoke something we could not parse as the git protocol. */
export class GitProtocolError extends GitWireError {
  override name = "GitProtocolError";
}

/** The server reported a fatal error in-band (`ERR` pkt-line or sideband channel 3). */
export class RemoteError extends GitWireError {
  override name = "RemoteError";
}

/** A ref update was refused. Subclasses say why; `reason` is the server's raw text. */
export class RefUpdateError extends GitWireError {
  override name = "RefUpdateError";
  constructor(
    readonly ref: string,
    readonly reason: string,
  ) {
    super(`${ref}: ${reason}`);
  }
}

/** Compare-and-swap lost: the ref is no longer at the expected old SHA (or is locked by a racer). */
export class StaleRefError extends RefUpdateError {
  override name = "StaleRefError";
}

/** The new tip (or something it reaches) is not in the remote: transfer the objects first. */
export class MissingObjectError extends RefUpdateError {
  override name = "MissingObjectError";
}

/** Any other refusal: hooks, policy (`denyNonFastForwards`, `denyDeletes`), corrupt pack… */
export class RejectedError extends RefUpdateError {
  override name = "RejectedError";
}
