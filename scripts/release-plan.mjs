import { planRelease } from "./release-lib.mjs";

const plan = planRelease({
  eventName: process.env.GITHUB_EVENT_NAME,
  refName: process.env.GITHUB_REF_NAME,
  inputTag: process.env.INPUT_TAG,
});

process.stdout.write(
  `tag=${plan.tag}\nversion=${plan.version}\nnpm_tag=${plan.npmTag}\ndry_run=${String(plan.dryRun)}\n`,
);
