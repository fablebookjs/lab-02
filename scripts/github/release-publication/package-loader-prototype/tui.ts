// PROTOTYPE QUESTION:
// Can one credentialless loader select a native Tagged Release API when
// present, otherwise use the legacy npm command, and converge both sources on
// the same release package set without allowing broken-native fallback?

import { dirname, join, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { loadReleasePackages, type LoaderResult } from './loader.ts';

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const fixturesRoot = join(prototypeRoot, 'fixtures');
const scenarios = {
  native: { key: 'n', label: 'native v1 catalog', version: '3.0.0' },
  legacy: { key: 'l', label: 'legacy npm command', version: '3.0.0' },
  broken: { key: 'b', label: 'broken native (legacy also exists)', version: '3.0.0' },
  unsupported: { key: 'u', label: 'unsupported snapshot', version: '3.0.0' },
} as const;

type Scenario = keyof typeof scenarios;
type State = {
  error: string | null;
  result: LoaderResult | null;
  scenario: Scenario | null;
};

let state: State = { error: null, result: null, scenario: null };

const render = (): void => {
  if (process.stdout.isTTY) console.clear();
  console.log('\x1b[1mPROTOTYPE — credentialless tagged package-set loader\x1b[0m');
  console.log(
    '\x1b[2mQuestion: can native and legacy selection converge without falling back from a broken native API?\x1b[0m\n',
  );
  console.log('\x1b[1mCurrent state\x1b[0m');
  console.log(JSON.stringify(state, null, 2));
  console.log('\n\x1b[1mActions\x1b[0m');
  console.log(
    Object.entries(scenarios)
      .map(([, value]) => `[\x1b[1m${value.key}\x1b[0m] ${value.label}`)
      .join('  '),
  );
  console.log('[\x1b[1mq\x1b[0m] quit');
};

const runScenario = async (scenario: Scenario): Promise<void> => {
  try {
    state = {
      error: null,
      result: await loadReleasePackages(
        join(fixturesRoot, scenario),
        scenarios[scenario].version,
      ),
      scenario,
    };
  } catch (error) {
    state = {
      error: error instanceof Error ? error.message : String(error),
      result: null,
      scenario,
    };
  }
  render();
};

const main = async (): Promise<void> => {
  const requested = process.argv[2];
  if (requested !== undefined) {
    if (!(requested in scenarios)) throw new Error(`Unknown scenario: ${requested}`);
    await runScenario(requested as Scenario);
    return;
  }

  render();
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (_text, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      return;
    }
    const scenario = Object.entries(scenarios).find(([, value]) => value.key === key.name)?.[0];
    if (scenario !== undefined) void runScenario(scenario as Scenario);
  });
};

void main();
