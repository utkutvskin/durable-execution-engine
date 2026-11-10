# Releasing

A release is produced by a tag. Nobody types `npm publish` or `docker push` by hand.

## What the pipeline does

`.github/workflows/release.yml` runs when a tag that starts with `v` is pushed.

1. `plan` reads the tag. A plain tag such as `v0.2.0` is a release. A tag with a suffix such as `v0.2.0-rc.1` is a dry run.
2. `verify` runs `pnpm run verify` against a Postgres service.
3. `npm` builds the packages, packs them, runs `publint` and `attw`, and publishes the eight tarballs in dependency order with `npm publish --provenance`. It authenticates with the identity of the workflow (npm trusted publishing), so no token is stored.
4. `image` builds the image for amd64 and arm64 with an SBOM and provenance, and pushes it to `ghcr.io/utkutvskin/durable-execution-engine` under the tags `0.2.0`, `0.2` and `0` and `latest`. The image runs from `dist`.
5. `github-release` cuts the section of the tag out of `CHANGELOG.md` and creates the GitHub release.

A dry run executes every step. `npm publish` runs with `--dry-run`, the login to GHCR is skipped, the image is built but not pushed, and the GitHub release is created as a draft pre-release that you delete afterwards.

## Cutting a release

1. Add a changeset for every user visible change with `pnpm run changeset`. The eight packages are one fixed version group, so any changeset moves all of them.
2. Run `pnpm run release:version`. It bumps every `package.json` to the same version and deletes the used changesets.
3. Write the section `## [x.y.z] - yyyy-mm-dd` in `CHANGELOG.md`. It becomes the release note.
4. Commit, push to `main`, wait for CI.
5. Push a pre-release tag first (`git tag v0.2.0-rc.1 && git push origin v0.2.0-rc.1`) and read the run: it must be green.
6. Push the release tag (`git tag v0.2.0 && git push origin v0.2.0`). The tag must equal the version in the packages.

A dry run can also be started without a tag: Actions, release, Run workflow, with a pre-release tag such as `v0.1.1-rc.1`. The packages may carry the base version of a pre-release tag.

## One-time steps for the owner

These need the owner's accounts and cannot be done by the pipeline or by an agent.

### npm scope

1. Create the npm organization `dee` (or the scope that the package names use) on npmjs.com and make sure your account can publish to it. The packages are public (`publishConfig.access`).
2. If the scope is taken, rename the packages in one change and update the imports; the names are listed in `.changeset/config.json`.

### Trusted publisher

Trusted publishing exists per package, and a package must exist before it can be configured, so the first version of each package is published once by hand.

1. For each of the eight packages, on npmjs.com open the package, Settings, Trusted publisher, and add a GitHub Actions publisher: organization or user `utkutvskin`, repository `durable-execution-engine`, workflow file `release.yml`, no environment.
2. Packages to configure: `@dee/core`, `@dee/worker`, `@dee/api`, `@dee/ui`, `@dee/cli`, `@dee/example-hello`, `@dee/example-payment-saga`, `@dee/example-etl-pipeline`.
3. Optionally set each package to require two factor authentication and disallow tokens.

### GHCR

1. After the first real run, open the package `durable-execution-engine` under your GitHub profile, Packages, and set its visibility to public.
2. In the package settings, link it to the repository and give the repository write access, so the workflow token can keep pushing.

### Repository

1. Make sure Actions are allowed to create releases: Settings, Actions, General, workflow permissions can stay read only, the workflow asks for what it needs.
2. Protect nothing that blocks tag pushes from you.

## Things that can go wrong

- A half published release: npm does not allow a version to be published twice. Fix the cause, bump a patch version, tag again.
- The dry run leaves a draft release for its tag name. Delete it in the GitHub releases list.
- A plain tag whose version differs from the packages fails in `npm` before anything is published.
