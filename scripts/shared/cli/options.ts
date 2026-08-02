/**
 * Resolves a required command option while preserving its flag name in the
 * failure. Validation beyond presence belongs to the option's domain owner.
 */
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
