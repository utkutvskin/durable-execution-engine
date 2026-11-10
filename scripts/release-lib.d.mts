export interface ParsedTag {
  readonly tag: string;
  readonly version: string;
  readonly base: string;
  readonly prerelease: boolean;
  readonly npmTag: "latest" | "next";
}

export interface ReleasePlan {
  readonly tag: string;
  readonly version: string;
  readonly npmTag: "latest" | "next";
  readonly dryRun: boolean;
}

export function parseTag(tag: string): ParsedTag;
export function assertVersionMatchesTag(tag: string, version: string): void;
export function extractReleaseNotes(changelog: string, tag: string): string;
export function tarballName(manifest: { readonly name: string; readonly version: string }): string;
export function publishCommands(options: {
  readonly tarballs: readonly string[];
  readonly tag: string;
  readonly dryRun: boolean;
}): string[][];
export function planRelease(options: {
  readonly eventName: string | undefined;
  readonly refName: string | undefined;
  readonly inputTag?: string | undefined;
}): ReleasePlan;
