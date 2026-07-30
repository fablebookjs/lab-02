import {
  listWorkspacePackages,
  type WorkspacePackage,
} from '../../scripts/api/v1/workspace-packages.ts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

export type WorkspacePackagesV1ParametersContract = Expect<
  Equal<Parameters<typeof listWorkspacePackages>, []>
>;
export type WorkspacePackagesV1ReturnContract = Expect<
  Equal<ReturnType<typeof listWorkspacePackages>, Promise<readonly WorkspacePackage[]>>
>;

const list: () => Promise<readonly WorkspacePackage[]> = listWorkspacePackages;

async function consumeWorkspacePackagesV1(): Promise<void> {
  const packages = await list();
  for (const pkg of packages) {
    const location: string = pkg.location;
    const name: string = pkg.name;
    const version: string = pkg.version;
    const isPrivate: boolean = pkg.private;
    void [location, name, version, isPrivate];
  }
}

void consumeWorkspacePackagesV1;
