import { listPublicPackages } from '../shared/workspace/packages.ts';

const packages = await listPublicPackages();
console.log(
  JSON.stringify(
    packages.map(({ location, name, version }) => ({ location, name, version })),
    null,
    2,
  ),
);
