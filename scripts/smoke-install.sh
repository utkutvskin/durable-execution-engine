#!/bin/sh
set -eu

packed="${1:?usage: smoke-install.sh <directory with the packed tarballs>}"
packed="$(cd "$packed" && pwd)"
work="$(mktemp -d)"
cd "$work"

node - "$packed" <<'NODE'
const { readdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const directory = path.resolve(process.argv[2]);
const dependencies = {};
for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".tgz"))) {
  const match = /^dee-(.+)-\d+\.\d+\.\d+.*\.tgz$/.exec(name);
  const key = `@dee/${match[1]}`;
  dependencies[key] = `file:${path.join(directory, name)}`;
}
writeFileSync(
  "package.json",
  JSON.stringify({ name: "smoke", private: true, type: "module", dependencies, overrides: dependencies }),
);
NODE

npm install --no-audit --no-fund
npx wf help > /dev/null

npx wf dev --module node_modules/@dee/example-hello/dist/index.js > dev.log 2>&1 &
dev=$!
trap 'kill "$dev" 2>/dev/null || true' EXIT

for attempt in $(seq 1 60); do
  if [ -f .wf/dev.json ]; then break; fi
  sleep 1
done
if [ ! -f .wf/dev.json ]; then
  cat dev.log
  echo "wf dev did not write .wf/dev.json" >&2
  exit 1
fi

npx wf run start hello --input '{"name":"ada"}' --wait | tee result.txt
grep -q "COMPLETED" result.txt
grep -q "hello, ada" result.txt
echo "the hello workflow completed from the packed packages"
