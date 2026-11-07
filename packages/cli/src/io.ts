import { createInterface } from "node:readline/promises";

/**
 * What a command may touch of the outside world: where it prints, which
 * environment it reads and which directory relative paths resolve against.
 * `confirm` asks a yes or no question on a terminal and resolves true for a
 * yes; an io without it, or a process without a terminal, cannot be asked.
 * Tests pass their own.
 */
export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly confirm?: (question: string) => Promise<boolean>;
}

/**
 * The `CliIo` of the real process.
 */
export function processIo(): CliIo {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  return {
    ...(interactive
      ? {
          confirm: async (question: string): Promise<boolean> => {
            const readline = createInterface({ input: process.stdin, output: process.stderr });
            try {
              const answer = await readline.question(`${question} [y/N] `);
              return /^y(es)?$/i.test(answer.trim());
            } finally {
              readline.close();
            }
          },
        }
      : {}),
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
