import type { ApiKeyStore, IssueKeyOptions, IssuedApiKey } from "./api-keys.ts";

/**
 * Creates the namespace when needed and issues a key for it, which tests
 * need often now that issuing a key no longer creates its namespace.
 */
export async function issueTestKey(
  store: ApiKeyStore,
  namespace: string,
  options?: IssueKeyOptions,
): Promise<IssuedApiKey> {
  await store.ensureNamespace(namespace);
  return store.issue(namespace, options);
}
