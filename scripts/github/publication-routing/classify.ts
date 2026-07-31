import { classifyPublicationRoute } from '../../shared/publication-routing/core.ts';
import { validatedWorkflowRunCompletion } from '../events.ts';
import { setNamedOutputs } from '../runtime.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  context,
  core,
}: GitHubHandlerRuntime): Promise<void> {
  const input = validatedWorkflowRunCompletion(
    context.eventName,
    context.payload,
  );
  const decision = classifyPublicationRoute(input);
  if (decision.kind === 'skip') {
    core.notice(`Publication skipped: ${decision.reason}`);
    setNamedOutputs(core, {
      'authority-kind': '',
      publish: false,
      'skip-reason': decision.reason,
      'upstream-run-id': input.runId,
    });
    return;
  }
  core.info(
    `Routing upstream run ${decision.upstreamRunId} as ${decision.authorityKind}.`,
  );
  setNamedOutputs(core, {
    'authority-kind': decision.authorityKind,
    publish: true,
    'skip-reason': '',
    'upstream-run-id': decision.upstreamRunId,
  });
}
