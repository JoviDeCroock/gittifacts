export type Handler = (input: string) => string;

export const upper: Handler = (s) => s.toUpperCase();
export const lower: Handler = (s) => s.toLowerCase();
export const reverse: Handler = (s) => [...s].reverse().join("");

export const handlers: Record<string, Handler> = {
  upper,
  lower,
  reverse,
};

export function run(name: string, input: string): string {
  const handler = handlers[name];
  if (!handler) throw new Error(`unknown handler: ${name}`);
  return handler(input);
}
