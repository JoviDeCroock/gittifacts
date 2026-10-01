export interface Signup {
  email: string;
  age: number;
}

export function register(input: Signup): string {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("invalid email");
  if (input.age < 13) throw new Error("too young");
  return `registered ${email}`;
}
