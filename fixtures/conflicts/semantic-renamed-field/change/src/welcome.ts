import type { User } from "./user.js";

export function welcome(user: User): string {
  return `Welcome back, ${user.name}!`;
}
