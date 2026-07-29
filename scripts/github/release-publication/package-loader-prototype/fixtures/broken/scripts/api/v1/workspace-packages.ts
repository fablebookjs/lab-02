throw new Error('The prototype native API is intentionally broken.');

export async function listWorkspacePackages(): Promise<readonly never[]> {
  return [];
}
