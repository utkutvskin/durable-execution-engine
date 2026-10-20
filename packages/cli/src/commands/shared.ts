import { parseArgs } from "node:util";
import { CliError } from "../errors.js";

/**
 * The shape of the options of one command, as `node:util` `parseArgs` takes
 * them.
 */
export type OptionSpec = Record<
  string,
  { readonly type: "string" | "boolean"; readonly multiple?: boolean; readonly short?: string }
>;

/**
 * Parsed flags and positional arguments of a command.
 */
export interface ParsedCommand {
  readonly values: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
  readonly positionals: readonly string[];
}

/**
 * Parses `args` against `options`, turning an unknown flag or a missing value
 * into a `CliError` that names the problem.
 */
export function parseCommand(args: readonly string[], options: OptionSpec): ParsedCommand {
  try {
    const parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
    return { values: parsed.values, positionals: parsed.positionals };
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message.toLowerCase() : String(error), 2);
  }
}

/**
 * The string value of a flag, if it was given.
 */
export function stringFlag(parsed: ParsedCommand, name: string): string | undefined {
  const value = parsed.values[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Every value of a repeatable string flag.
 */
export function stringFlags(parsed: ParsedCommand, name: string): string[] {
  const value = parsed.values[name];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof value === "string" ? [value] : [];
}

/**
 * Whether a boolean flag was given.
 */
export function booleanFlag(parsed: ParsedCommand, name: string): boolean {
  return parsed.values[name] === true;
}

/**
 * The positional argument at `index`, or a `CliError` that says what is
 * missing.
 */
export function requirePositional(
  parsed: ParsedCommand,
  index: number,
  description: string,
): string {
  const value = parsed.positionals[index];
  if (value === undefined) {
    throw new CliError(`missing ${description}`, 2);
  }
  return value;
}

/**
 * Parses a flag that holds json.
 */
export function parseJsonFlag(text: string | undefined, flag: string): unknown {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(`--${flag} is not valid json`, 2);
  }
}
