import type * as core from '@actions/core';
import type { getOctokit } from '@actions/github';

export type GitHubClient = ReturnType<typeof getOctokit>;

export type GitHubHandlerRuntime = {
  core: typeof core;
  context: {
    eventName: string;
    payload: unknown;
    repo: {
      owner: string;
      repo: string;
    };
  };
  env: Readonly<NodeJS.ProcessEnv>;
  github: GitHubClient;
};

export function requireEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment value ${name}.`);
  }
  return value;
}

export async function authenticatedToken(github: GitHubClient): Promise<string> {
  const authentication: unknown = await github.auth();
  if (
    typeof authentication !== 'object' ||
    authentication === null ||
    !('token' in authentication) ||
    typeof authentication.token !== 'string' ||
    authentication.token.length === 0
  ) {
    throw new Error('The injected GitHub client did not expose token authentication.');
  }
  return authentication.token;
}

export function setNamedOutputs(
  output: typeof core,
  values: Readonly<Record<string, boolean | number | string>>,
): void {
  for (const [name, value] of Object.entries(values)) output.setOutput(name, value);
}
