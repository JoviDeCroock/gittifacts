/** Thrown by producers when a tool's output cannot be understood. */
export class ProducerInputError extends Error {
  override readonly name = "ProducerInputError";
}
