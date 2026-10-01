export type Handler = (input: string) => string;

export const upper: Handler = (s) => s.toUpperCase();
export const lower: Handler = (s) => s.toLowerCase();
export const trim: Handler = (s) => s.trim();

export const handlers: Record<string, Handler> = {
  upper,
  lower,
  trim,
};

export function run(name: string, input: string): string {
  const handler = handlers[name];
  if (!handler) throw new Error(`unknown handler: ${name}`);
  return handler(input);
}
