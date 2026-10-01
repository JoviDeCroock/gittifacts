export interface User {
  id: number;
  displayName: string;
}

export function makeUser(id: number, name: string): User {
  return { id, displayName: name };
}

export function label(user: User): string {
  return `#${user.id} ${user.displayName}`;
}
