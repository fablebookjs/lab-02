export type PullRequestRoute = {
  baseRef: string;
  headRef: string;
  headRepository: string;
  repository: string;
};

const RELEASE_LINE = /^releases\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const RELEASE_PROPOSAL = /^staged\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const PATCHBACK = /^patchbacks\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

const reservedHead = (ref: string): boolean =>
  ref === 'main' ||
  ref === 'prerelease' ||
  ref.startsWith('releases/') ||
  ref.startsWith('staged/') ||
  ref.startsWith('patchbacks/');

export function pullRequestRouteError(input: PullRequestRoute): string | null {
  if (input.baseRef !== 'main' && !input.baseRef.startsWith('releases/v')) return null;

  const releaseBase = RELEASE_LINE.exec(input.baseRef);
  if (input.baseRef !== 'main' && releaseBase === null) {
    return `Unsupported release-line base branch ${input.baseRef}.`;
  }

  const sameRepository = input.headRepository === input.repository;
  const releaseHead = RELEASE_LINE.exec(input.headRef);
  const proposalHead = RELEASE_PROPOSAL.exec(input.headRef);

  if (input.baseRef === 'main') {
    if (input.headRef === 'prerelease' || PATCHBACK.test(input.headRef)) {
      return sameRepository
        ? null
        : `Reserved branch ${input.headRef} must come from ${input.repository}.`;
    }
    if (releaseHead !== null || input.headRef.startsWith('releases/')) {
      return `Release line ${input.headRef} cannot target development line main.`;
    }
    if (proposalHead !== null || input.headRef.startsWith('staged/')) {
      return `Release proposal ${input.headRef} must target its matching release line.`;
    }
    if (input.headRef.startsWith('patchbacks/')) {
      return `Unsupported patchback branch ${input.headRef}.`;
    }
    if (sameRepository && input.headRef === 'main') {
      return 'Development line main cannot be used as a pull request head.';
    }
    return null;
  }

  if (proposalHead !== null) {
    if (!sameRepository) {
      return `Reserved branch ${input.headRef} must come from ${input.repository}.`;
    }
    const expectedBase = `releases/${proposalHead[1]}`;
    return input.baseRef === expectedBase
      ? null
      : `Release proposal ${input.headRef} must target ${expectedBase}, not ${input.baseRef}.`;
  }

  if (reservedHead(input.headRef) && sameRepository) {
    return `Reserved branch ${input.headRef} cannot target release line ${releaseBase?.[1]}.`;
  }
  if (
    input.headRef === 'prerelease' ||
    input.headRef.startsWith('releases/') ||
    input.headRef.startsWith('staged/') ||
    input.headRef.startsWith('patchbacks/')
  ) {
    return `Reserved branch ${input.headRef} must come from ${input.repository}.`;
  }
  return null;
}
