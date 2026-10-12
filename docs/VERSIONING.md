# Workflow versioning guide

A workflow run can live for days. The code that started it is often gone by the time it finishes. Replay runs the current code over the recorded history, so changing a workflow in a way that alters its sequence of steps, timers or children breaks runs that are already half finished: the replay raises a `NonDeterminismError`. Patch gates let one deployed version of the code serve both the old runs and the new ones.

## What needs a patch

A change needs a gate when it alters what a replay of an old history would do:

- adding, removing or reordering a `ctx.step()`, `ctx.sleep()` or `ctx.startChild()` call
- changing the step type or the input of an existing call
- changing the control flow that decides which of those calls happen

A change does not need a gate when it cannot be seen from the history: the body of a step handler, a log line, a refactor that issues the same calls in the same order with the same inputs.

## ctx.patched(patchId)

```ts
if (ctx.patched("verify-email")) {
  await ctx.step("verify-email", {});
}
await ctx.step("send-welcome", {});
```

`patched` returns a boolean to branch on:

- `true` for a run that reaches the call for the first time on this code. The decision records a `patch_recorded` event, so every later replay of that run answers `true` again.
- `false` for a run whose history already moved past the call on older code, meaning the history holds more scheduled steps, timers or children than the code issued before reaching the call. That run keeps the old branch.

The answer for one `patchId` is the same on every call within one replay, so a loop that asks again on every iteration sees one consistent branch.

A run that was suspended exactly at the call, for instance waiting on a timer or a signal, has not passed it yet and takes the new branch once it resumes.

## ctx.deprecatePatch(patchId)

Once no open run can take the old branch any more, replace the branch with the new code and leave a marker behind:

```ts
ctx.deprecatePatch("verify-email");
await ctx.step("verify-email", {});
await ctx.step("send-welcome", {});
```

`deprecatePatch` does not branch. It still records the patch for runs reaching it for the first time, so a worker running the previous version, which still calls `patched`, can replay them.

## Lifecycle of a change

1. Deploy the version with `ctx.patched(id)`. Old runs keep the old branch, new runs take the new one.
2. Wait until every run that started before the deployment has closed. Check with the run projections: no open run may have a history without `patch_recorded` for the id that is past the gate.
3. Replace `patched` with `deprecatePatch` and delete the old branch.
4. Wait until no open run is on the version that used `patched`.
5. Delete the `deprecatePatch` call.

Step 5 is only safe when no open run holds a `patch_recorded` event for the id: see the next section.

## Build ids and safe rejection

`DecisionLoopOptions.buildId` names the build of the worker deciding a run. It is stamped on every `patch_recorded` event the build writes.

When a worker replays a history that holds a `patch_recorded` event for an id its code never asks about, it throws `VersionMismatchError` instead of deciding. The run is not failed: the error is an integrity error like `NonDeterminismError`, so the caller must nack the workflow task and let it be redelivered to a worker of a matching build. The message names the patch ids and the build ids that recorded them. Queries are refused the same way.

This is what protects a rolling deployment: while the old and the new build are both running, an old worker never makes a decision about a run the new build has already patched. It is also why step 5 above must wait for the runs to close.

## Limits

- The frontier test counts scheduled steps, timers and children. A change that is visible only through signal consumption or `ctx.now()` cannot be told apart from the old behavior by the gate.
- A run decided with a patch is replayed from the top on every task: a live session in the sticky cache does not resume workflows that call `patched` or `deprecatePatch` (see ADR-0031).
- Old histories are tested with recorded fixtures: add the history of a half finished run under `test/fixtures/histories/` before changing a workflow, and keep it until its patch is removed.
