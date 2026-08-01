export function requireControllerGitHubToken(options: {
  'github-token': string;
}): string {
  const token = options['github-token'];
  if (!token) {
    throw new Error('An authenticated GitHub capability is required.');
  }
  return token;
}
