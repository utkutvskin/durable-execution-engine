/**
 * What a command may touch of the outside world: where it prints, which
 * environment it reads and which directory relative paths resolve against.
 * Tests pass their own.
 */
export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/**
 * The `CliIo` of the real process.
 */
export function processIo(): CliIo {
  return {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    env: process.env,
    cwd: process.cwd(),
  };
}
