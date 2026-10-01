/** "hello world" → "Hello World"; short all-caps words are acronyms and stay ("the API" → "The API"). */
export function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) =>
      word.length <= 3 && word === word.toUpperCase() && /[A-Z]/.test(word)
        ? word
        : word[0]?.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}
