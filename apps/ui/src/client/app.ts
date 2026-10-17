import { ApiError, createApiClient, type ApiClient } from "./api.js";
import { mountDeadLettersView } from "./dead-letters-view.js";
import { h } from "./dom.js";
import { mountRunView } from "./run-view.js";
import { mountRunsView } from "./runs-view.js";

const KEY_STORAGE = "dee.apiKey";

function readStoredKey(): string | undefined {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeKey(key: string | undefined): void {
  try {
    if (key === undefined) {
      sessionStorage.removeItem(KEY_STORAGE);
    } else {
      sessionStorage.setItem(KEY_STORAGE, key);
    }
  } catch {
    return;
  }
}

/**
 * Starts the app inside `root`: a sign in form for an api key, then the run
 * list, the run detail and the dead letter queue behind a hash router.
 */
export function startApp(root: HTMLElement): void {
  const banner = h("p", { className: "banner", testId: "banner" });
  banner.hidden = true;
  const content = h("main", { testId: "content" });
  let api: ApiClient | undefined;
  let namespaceName = "";
  let unmount: () => void = () => undefined;

  function showError(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      signOut();
      return;
    }
    banner.textContent = error instanceof Error ? error.message : "something went wrong";
    banner.hidden = false;
  }

  function signOut(): void {
    unmount();
    unmount = () => undefined;
    storeKey(undefined);
    api = undefined;
    renderSignIn("the api key was rejected");
  }

  function route(): void {
    unmount();
    unmount = () => undefined;
    banner.hidden = true;
    if (api === undefined) {
      return;
    }
    const hash = window.location.hash.replace(/^#/, "");
    const run = /^\/runs\/([^/]+)$/.exec(hash);
    if (run?.[1] !== undefined) {
      unmount = mountRunView(content, api, decodeURIComponent(run[1]), showError);
    } else if (hash === "/dead-letters") {
      unmount = mountDeadLettersView(content, api, showError);
    } else {
      unmount = mountRunsView(content, api, namespaceName, showError);
    }
  }

  async function enter(key: string): Promise<void> {
    const client = createApiClient(key, (input, init) => fetch(input, init));
    const namespace = await client.namespace();
    api = client;
    namespaceName = namespace.name;
    storeKey(key);
    root.replaceChildren(
      h(
        "header",
        {},
        h("h1", {}, "dee"),
        h("span", { className: "namespace", testId: "namespace-name" }, namespace.name),
        h(
          "nav",
          {},
          h("a", { href: "#/", testId: "nav-runs" }, "runs"),
          h("a", { href: "#/dead-letters", testId: "nav-dead-letters" }, "dead letters"),
          h("button", { type: "button", testId: "sign-out", onClick: signOut }, "sign out"),
        ),
      ),
      banner,
      content,
    );
    route();
  }

  function renderSignIn(problem?: string): void {
    const input = h("input", {
      testId: "api-key-input",
      type: "password",
      name: "apiKey",
      placeholder: "api key",
    });
    const error = h("p", { className: "banner", testId: "sign-in-error" }, problem ?? "");
    error.hidden = problem === undefined;
    root.replaceChildren(
      h(
        "form",
        {
          className: "sign-in",
          onSubmit: (event) => {
            event.preventDefault();
            enter(input.value.trim()).catch(() => {
              error.textContent = "the api key was rejected";
              error.hidden = false;
            });
          },
        },
        h("h1", {}, "dee"),
        input,
        h("button", { type: "submit", testId: "sign-in" }, "sign in"),
        error,
      ),
    );
  }

  window.addEventListener("hashchange", route);
  const stored = readStoredKey();
  if (stored === undefined) {
    renderSignIn();
  } else {
    enter(stored).catch(() => {
      storeKey(undefined);
      renderSignIn();
    });
  }
}
