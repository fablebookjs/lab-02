export function requireOption<Name extends string>(
  options: Record<Name, string | undefined>,
  name: Name,
): string {
  const value = options[name];
  if (!value) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}
