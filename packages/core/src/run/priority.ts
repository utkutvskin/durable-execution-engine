/**
 * The lowest and highest priority a run can have. Higher runs first.
 */
export const PRIORITY_RANGE = { min: -1000, max: 1000 } as const;

/**
 * The priority of a run started without one.
 */
export const DEFAULT_PRIORITY = 0;

/**
 * Thrown when a start asks for a priority that is not an integer within
 * `PRIORITY_RANGE`.
 */
export class InvalidPriorityError extends RangeError {
  readonly priority: unknown;

  constructor(priority: unknown) {
    super(
      `priority must be an integer from ${String(PRIORITY_RANGE.min)} to ${String(PRIORITY_RANGE.max)}, got ${String(priority)}`,
    );
    this.name = "InvalidPriorityError";
    this.priority = priority;
  }
}

/**
 * Returns the priority a run is started with: `DEFAULT_PRIORITY` when none is
 * given, the given one when it is an integer within `PRIORITY_RANGE`. Rejects
 * anything else with `InvalidPriorityError`.
 */
export function validatePriority(priority: number | undefined): number {
  if (priority === undefined) {
    return DEFAULT_PRIORITY;
  }
  if (
    !Number.isInteger(priority) ||
    priority < PRIORITY_RANGE.min ||
    priority > PRIORITY_RANGE.max
  ) {
    throw new InvalidPriorityError(priority);
  }
  return priority;
}
