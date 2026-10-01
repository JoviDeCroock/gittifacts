export interface Config {
  retries: number;
  timeoutMs: number;
  baseUrl: string;
  verbose: boolean;
}

export const defaults: Config = {
  retries: 3,
  timeoutMs: 5000,
  baseUrl: "https://api.example.com",
  verbose: false,
};

export function withDefaults(partial: Partial<Config>): Config {
  return { ...defaults, ...partial };
}
