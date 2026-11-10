/**
 * The publishable workspace directories in dependency order: a package comes after every package it depends on.
 */
export const PACKAGE_DIRECTORIES = [
  "packages/core",
  "packages/worker",
  "packages/api",
  "apps/ui",
  "examples/hello",
  "examples/payment-saga",
  "examples/etl-pipeline",
  "packages/cli",
];
