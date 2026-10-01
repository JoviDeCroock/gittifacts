export interface Signup {
  email: string;
  age: number;
}

export function validate(input: Signup): void {
  if (!input.email.includes("@")) throw new Error("invalid email");
  if (input.age < 13) throw new Error("too young");
}

export function register(input: Signup): string {
  validate(input);
  return `registered ${input.email}`;
}
