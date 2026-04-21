export function formatGreeting(name = "world"): string {
  return `Hello, ${name}!`;
}

export function main(args: readonly string[] = Bun.argv.slice(2)): void {
  const [name = "world"] = args;

  console.log(formatGreeting(name));
}

if (import.meta.main) {
  main();
}
