# Chaos report

This report is written by the chaos suite (`packages/worker/src/chaos/chaos-suite.integration.test.ts`). Each scenario injects one kind of failure into a real Postgres, lets the engine recover, and then runs the invariant checker over every run, task, step result, timer and projection the repetition touched.

Regenerate it with:

```sh
DEE_CHAOS_REPORT=docs/CHAOS_REPORT.md pnpm exec vitest run packages/worker/src/chaos/chaos-suite.integration.test.ts
pnpm exec prettier --write docs/CHAOS_REPORT.md
```

## Result

60 repetitions across 6 scenarios, 0 invariant violations.

| Scenario                              | Repetitions | Runs | Faults injected | Task redeliveries | Errors survived | Violations | Slowest repetition |
| ------------------------------------- | ----------: | ---: | --------------: | ----------------: | --------------: | ---------: | -----------------: |
| Worker kill                           |          10 |   40 |              20 |                20 |               0 |          0 |             738 ms |
| Database connection loss and recovery |          10 |   60 |              79 |               146 |             383 |          0 |             453 ms |
| Double delivery                       |          10 |   40 |              76 |                76 |               0 |          0 |              49 ms |
| Clock shifted forward and backward    |          10 |   60 |              60 |                10 |               0 |          0 |              65 ms |
| Slow disk                             |          10 |   80 |            1682 |                73 |               0 |          0 |             592 ms |
| Network latency                       |          10 |   60 |            6234 |                40 |               0 |          0 |            1634 ms |

## Invariants

- `run-terminal-or-advancing`: A run is either terminal or has something that will move it: an open task, a pending timer, an open dead letter or a running child.
- `task-not-lost`: A task that was enqueued still exists, a leased task carries a lease token, and an acked step task left its step an outcome, a failed attempt or a dead letter.
- `step-result-written-once`: A step has at most one terminal event and one stored result, and every stored result has its event.
- `projection-consistent`: The run row equals the fold of the event log up to its own sequence number, never runs ahead of the log, and is terminal whenever the log is.
- `timer-fired-once`: A timer has at most one fired event, a fired timer has its event, and no timer fires before it is due.

The suite also reports these checks of its own:

- `workload-converged`: Every run reached a terminal state before the deadline.
- `workload-result`: Every run completed with the result its inputs determine.
- `ack-accepted-once`: A task that was delivered several times accepted one ack.
- `fault-injected`: The repetition really injected a fault.
- `scenario-error`: The harness itself did not fail.

## Scenarios

### Worker kill

Two worker processes each take a task and are stopped with SIGKILL at a random point (before the step result is recorded, after it, or after the run finished but before the ack). A janitor reclaims their leases and two fresh workers finish every run.

Fidelity: Real operating system processes and a real signal. The kill lands only at the three checkpoints of the sample flow, not at an arbitrary instruction.

Seeds: 1000 to 1009.

### Database connection loss and recovery

The workers reach Postgres through a TCP proxy. At the checkpoints of the flow the proxy destroys every open connection, refuses the next reconnects, or lets a commit execute while swallowing its answer, so the worker cannot tell whether the transaction applied. A janitor reclaims what the workers could not nack.

Fidelity: The connections really die and pg really has to reconnect, but Postgres itself keeps running; a restarted server is not simulated.

Seeds: 2000 to 2009.

### Double delivery

Every task is leased, its visibility timeout expires, and it is delivered again, two to four times in all. Every delivery then runs concurrently, with random pauses between the steps of the handler, and each acks with its own lease token.

Fidelity: Real concurrent handlers over the real recorder and queue; the deliveries come from a moved clock rather than from a worker that really stalled.

Seeds: 3000 to 3009.

### Clock shifted forward and backward

Four runs wait on durable timers of 10 to 13 minutes and two runs have pending step tasks, one of them leased by a worker that vanished. The shared clock is moved backward and forward by minutes to hours several times, with two timer schedulers and a janitor ticking after every move, then jumps two days ahead.

Fidelity: The clock is an injected source, which is how every component reads time; the operating system clock is not changed.

Seeds: 4000 to 4009.

### Slow disk

Every insert, update, delete and commit takes 8 to 27 ms. Three workers with a 40 ms visibility timeout and a 15 ms heartbeat compete for eight runs, so leases expire in the middle of slow transactions and tasks are delivered to a second worker while the first is still writing.

Fidelity: The delay is added in front of write statements by a wrapper around the pool; the real disk and the real fsync are unchanged, and Postgres sees ordinary statements that arrive later.

Seeds: 5000 to 5009.

### Network latency

The workers reach Postgres through a TCP proxy that delays every packet in both directions by 2 to 9 ms, with bursts of 150 ms at some checkpoints. Two workers with an 80 ms visibility timeout and a 25 ms heartbeat compete for six runs, so heartbeats arrive late and leases are lost.

Fidelity: The delay is real packet delay on a local TCP connection; bandwidth limits, packet loss and reordering across hosts are not simulated.

Seeds: 6000 to 6009.

## Violations

None.

## Limits

- Zero violations over ten repetitions is evidence, not proof. The workloads are small (the sample flow and a timer flow) and the fault points are the ones the harness knows about.
- The invariant checker treats a running run with nothing to wait for as stalled, so the suite cannot park runs on signals.
- Slow disk and network latency are simulated in front of Postgres, not inside it. A real fsync stall, a full disk or a restarted server are not covered.
- Timings depend on the machine; the faults are seeded, the interleaving of the operating system scheduler is not.
