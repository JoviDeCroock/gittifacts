export interface Signup {
  email: string;
  age: number;
}

export function register(input: Signup): string {
  if (!input.email.includes("@")) throw new Error("invalid email");
  if (input.age < 13) throw new Error("too young");
  return `registered ${input.email}`;
}
