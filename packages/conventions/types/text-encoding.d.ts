// Only for `tsconfig.json` (src, no runtime types): @app/domain imports @app/evidence, whose
// encoding helpers use TextEncoder/TextDecoder. Declaring just these two keeps every other runtime
// global (fetch, URL, process, Buffer, crypto, ...) out of reach of src/.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}
