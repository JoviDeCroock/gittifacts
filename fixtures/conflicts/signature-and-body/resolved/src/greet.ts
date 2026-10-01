export function greet(name: string, greeting = "Hello"): string {
  const clean = name.trim();
  const display = clean.charAt(0).toUpperCase() + clean.slice(1);
  return greeting + ", " + display + "!";
}
