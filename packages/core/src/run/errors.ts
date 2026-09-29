/**
 * Thrown when something asks a run to move out of a state the transition
 * table does not allow, most importantly any change to a run that already
 * reached a terminal state. `from` is the run's current state and
 * `attempted` names what was attempted: the target state for a state
 * change, or the command type for a command.
 */
export class InvalidTransitionError extends Error {
  readonly from: string;
  readonly attempted: string;

  constructor(from: string, attempted: string) {
    super(`invalid run transition: cannot apply "${attempted}" to a run in state ${from}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.attempted = attempted;
  }
}
