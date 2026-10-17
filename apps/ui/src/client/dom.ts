/**
 * Attributes and handlers for `h`. `testId` becomes `data-testid`.
 */
export interface ElementProps {
  readonly className?: string;
  readonly testId?: string;
  readonly type?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly href?: string;
  readonly rows?: number;
  readonly disabled?: boolean;
  readonly name?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onSubmit?: (event: SubmitEvent) => void;
  readonly onChange?: (event: Event) => void;
}

/**
 * A child of `h`: text, an element, or nothing.
 */
export type Child = string | Node | null | undefined | false;

/**
 * Builds an element without ever parsing markup, so no run data can inject
 * html into the page: text always goes in as a text node.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.className !== undefined) {
    element.className = props.className;
  }
  if (props.testId !== undefined) {
    element.dataset["testid"] = props.testId;
  }
  for (const [name, value] of Object.entries(props.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
    if (props.type !== undefined) {
      element.type = props.type;
    }
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    if (props.value !== undefined) {
      element.value = props.value;
    }
    if (props.name !== undefined) {
      element.name = props.name;
    }
  }
  if (
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    props.placeholder !== undefined
  ) {
    element.placeholder = props.placeholder;
  }
  if (element instanceof HTMLTextAreaElement && props.rows !== undefined) {
    element.rows = props.rows;
  }
  if (element instanceof HTMLAnchorElement && props.href !== undefined) {
    element.href = props.href;
  }
  if (
    (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
    props.disabled !== undefined
  ) {
    element.disabled = props.disabled;
  }
  if (props.onClick !== undefined) {
    element.addEventListener("click", props.onClick as EventListener);
  }
  if (props.onSubmit !== undefined) {
    element.addEventListener("submit", props.onSubmit as EventListener);
  }
  if (props.onChange !== undefined) {
    element.addEventListener("change", props.onChange);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}
