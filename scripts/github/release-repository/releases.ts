import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import { booleanValue, objectValue, stringValue } from './response-schema.ts';
import { createGitRef, getRef } from './refs.ts';
import { githubRequest, githubRequestOrNull } from './transport.ts';

type AnnotatedTag = Readonly<{
  object: {
    sha: string;
    type: 'commit';
  };
  sha: string;
  tag: string;
}>;

export type GitHubRelease = {
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
};

const validateOid = (oid: unknown, label: string): string => {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return oid;
};

const annotatedTagValue = (value: unknown): AnnotatedTag => {
  const tag = objectValue(value, 'GitHub annotated tag response');
  const object = objectValue(tag['object'], 'GitHub annotated tag object');
  const type = object['type'];
  if (type !== 'commit') {
    throw new Error('GitHub annotated tag must target a commit.');
  }
  return {
    object: {
      sha: validateOid(object['sha'], 'Annotated tag target'),
      type,
    },
    sha: validateOid(tag['sha'], 'Annotated tag object'),
    tag: stringValue(tag['tag'], 'Annotated tag name'),
  };
};

const validatedReleaseResponse = (value: unknown): GitHubRelease => {
  const release = objectValue(value, 'GitHub Release');
  const body = release['body'];
  if (body !== null && typeof body !== 'string') {
    throw new Error('GitHub Release body must be text or null.');
  }
  return {
    body,
    draft: booleanValue(release['draft'], 'GitHub Release draft'),
    prerelease: booleanValue(release['prerelease'], 'GitHub Release prerelease'),
    tag_name: stringValue(release['tag_name'], 'GitHub Release tag_name'),
  };
};

export async function getReleaseByTag(
  token: string,
  tag: string,
): Promise<GitHubRelease | null> {
  const value = await githubRequestOrNull(
    `/repos/${PILOT_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
    token,
  );
  return value === null ? null : validatedReleaseResponse(value);
}

export async function readAnnotatedTag(
  token: string,
  tag: string,
): Promise<AnnotatedTag | null> {
  const ref = await getRef(token, `tags/${tag}`);
  if (ref === null) return null;
  if (ref.type !== 'tag') {
    throw new Error(`${tag} exists but is not an annotated tag.`);
  }
  return annotatedTagValue(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/tags/${ref.oid}`, { token }),
  );
}

export function assertTagTarget(
  tagObject: AnnotatedTag,
  tag: string,
  snapshotOid: string,
): void {
  if (
    tagObject.tag !== tag ||
    tagObject.object.type !== 'commit' ||
    tagObject.object.sha !== snapshotOid
  ) {
    throw new Error(`${tag} does not identify the authorized release snapshot.`);
  }
}

const waitFor = async <Value>(
  observe: () => Promise<Value>,
  attempts = 6,
): Promise<Value> => {
  let error: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await observe();
    } catch (nextError) {
      error = nextError;
      if (attempt + 1 < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
      }
    }
  }
  throw error instanceof Error ? error : new Error('Observation did not converge.');
};

export async function ensureAnnotatedTag(
  token: string,
  manifest: Readonly<{ snapshotOid: string; version: string }>,
): Promise<string> {
  const tag = `v${manifest.version}`;
  let tagObject = await readAnnotatedTag(token, tag);
  if (tagObject === null) {
    tagObject = annotatedTagValue(
      await githubRequest(`/repos/${PILOT_REPOSITORY}/git/tags`, {
        body: {
          message: `Release ${tag}`,
          object: manifest.snapshotOid,
          tag,
          tagger: {
            date: new Date().toISOString(),
            email: 'release-app@users.noreply.github.com',
            name: 'fablebook-release-app[bot]',
          },
          type: 'commit',
        },
        method: 'POST',
        token,
      }),
    );
    await createGitRef(token, `refs/tags/${tag}`, tagObject.sha);
    tagObject = await waitFor(async () => {
      const observed = await readAnnotatedTag(token, tag);
      if (observed === null) throw new Error(`${tag} is not visible yet.`);
      return observed;
    });
  }
  assertTagTarget(tagObject, tag, manifest.snapshotOid);
  return tag;
}

export async function ensureGitHubRelease(
  token: string,
  manifest: Readonly<{ snapshotOid: string }>,
  tag: string,
  body: string,
  prerelease = false,
): Promise<void> {
  let release = await getReleaseByTag(token, tag);
  if (release === null) {
    release = validatedReleaseResponse(
      await githubRequest(`/repos/${PILOT_REPOSITORY}/releases`, {
        body: {
          body,
          draft: false,
          name: tag,
          prerelease,
          tag_name: tag,
          target_commitish: manifest.snapshotOid,
        },
        method: 'POST',
        token,
      }),
    );
    if (release.body !== body) {
      throw new Error(`GitHub did not preserve the composed ${tag} release body.`);
    }
  }
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== prerelease ||
    release.body !== body
  ) {
    throw new Error(`GitHub Release ${tag} contradicts the completed release.`);
  }
}
