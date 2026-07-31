import { preparePromotion } from './promotion-controller.ts';
import {
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
}: GitHubHandlerRuntime): Promise<void> {
  await preparePromotion({
    manifest: requireEnvironment(env, 'PROMOTION_MANIFEST'),
    snapshot: requireEnvironment(env, 'SNAPSHOT'),
    'snapshot-oid': requireEnvironment(env, 'SNAPSHOT_OID'),
    version: requireEnvironment(env, 'RELEASE_VERSION'),
  });
}
