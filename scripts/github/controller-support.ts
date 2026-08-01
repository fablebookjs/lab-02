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

export function requireGithubToken(options: {
  'github-token': string;
}): string {
  const token = options['github-token'];
  if (!token) {
    throw new Error('An authenticated GitHub capability is required.');
  }
  return token;
}
