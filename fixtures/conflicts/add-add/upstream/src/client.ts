import { API_VERSION, MAX_RETRIES } from "./constants.js";

export const retries = MAX_RETRIES;

export function endpoint(path: string): string {
  return `/api/${API_VERSION}/${path}`;
}
