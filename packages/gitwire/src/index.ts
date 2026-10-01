/**
 * @app/gitwire — a dependency-free git smart-HTTP client for Cloudflare Workers (and Node 22).
 * Uses only fetch, crypto.subtle, CompressionStream and Uint8Array.
 */
export { type Bytes, ZERO_SHA, isSha } from "./bytes.js";
export {
  GitHttpError,
  GitProtocolError,
  GitWireError,
  MissingObjectError,
  RefUpdateError,
  RejectedError,
  RemoteError,
  StaleRefError,
} from "./errors.js";
export {
  AGENT,
  type GitAuth,
  type GitRemote,
  type GitService,
  type ListRefsOptions,
  type RefMap,
  listRefs,
} from "./http.js";
export {
  DEFAULT_NOTES_REF,
  MemoryObjectStore,
  type ObjectReader,
  type SignatureInput,
  type WriteNoteOptions,
  type WriteNoteResult,
  readNote,
  writeNote,
} from "./notes.js";
export {
  type Commit,
  type GitObject,
  type ObjectType,
  type Signature,
  type TreeEntry,
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  formatSignature,
  hashObject,
  isTreeMode,
  parseSignature,
} from "./objects.js";
export { type PackedObject, applyDelta, buildPack, parsePack } from "./pack.js";
export {
  DELIM,
  FLUSH,
  MAX_PKT_LEN,
  type PktLine,
  RESPONSE_END,
  demuxSideband,
  pktLine,
  pktText,
  readPktLines,
} from "./pktline.js";
export {
  type PushReport,
  type ReceivePackOptions,
  type RefResult,
  type RefUpdate,
  type TransferOptions,
  assertRefUpdated,
  fastForward,
  parseReport,
  receivePack,
  transferObjects,
} from "./receive.js";
export { type FetchPackOptions, fetchPack } from "./upload.js";
