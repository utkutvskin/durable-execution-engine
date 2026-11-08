# Chaos report

This report is written by the chaos suite (`packages/worker/src/chaos/chaos-suite.integration.test.ts`). Each scenario injects one kind of failure into a real Postgres, lets the engine recover, and then runs the invariant checker over every run, task, step result, timer and projection the repetition touched.

Regenerate it with:

```sh
DEE_CHAOS_REPORT=docs/CHAOS_REPORT.md pnpm exec vitest run packages/worker/src/chaos/chaos-suite.integration.test.ts
pnpm exec prettier --write docs/CHAOS_REPORT.md
```

## Result

170 repetitions across 17 scenario runs, 0 invariant violations.

| Scenario                                       | Repetitions | Runs | Faults injected | Task redeliveries | Errors survived | Violations | Slowest repetition |
| ---------------------------------------------- | ----------: | ---: | --------------: | ----------------: | --------------: | ---------: | -----------------: |
| Worker kill                                    |          10 |   40 |              20 |                20 |               0 |          0 |             809 ms |
| Database connection loss and recovery          |          10 |   60 |              80 |               161 |             383 |          0 |             636 ms |
| Double delivery                                |          10 |   40 |              64 |                64 |               0 |          0 |              63 ms |
| Clock shifted forward and backward             |          10 |   60 |              60 |                10 |               0 |          0 |              58 ms |
| Slow disk                                      |          10 |   80 |            1543 |                55 |               0 |          0 |             496 ms |
| Network latency                                |          10 |   60 |            6272 |                41 |               0 |          0 |            1804 ms |
| Worker kill (engine)                           |          10 |   40 |              20 |                20 |               0 |          0 |            1555 ms |
| Database connection loss and recovery (engine) |          10 |   60 |              49 |               106 |             344 |          0 |             631 ms |
| Double delivery (engine)                       |          10 |   40 |              64 |                64 |               0 |          0 |              65 ms |
| Clock shifted forward and backward (engine)    |          10 |   60 |              60 |                10 |               0 |          0 |             416 ms |
| Slow disk (engine)                             |          10 |   80 |            4258 |                78 |               0 |          0 |             815 ms |
| Network latency (engine)                       |          10 |   60 |           22682 |               154 |               0 |          0 |            3123 ms |
| Slow attempt racing a retry (engine)           |          10 |   30 |              30 |                30 |               0 |          0 |              86 ms |
| Two queues on one database (engine)            |          10 |   80 |              20 |                 0 |               0 |          0 |             310 ms |
| Clock skew between workers (engine)            |          10 |   70 |              20 |                19 |               0 |          0 |             195 ms |
| Pool smaller than concurrency (engine)         |          10 |  160 |              80 |                 0 |               0 |          0 |             172 ms |
| Runs waiting on a signal (engine)              |          10 |   80 |              40 |                 8 |               0 |          0 |             385 ms |

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
- `queue-isolation`: A task sits on the queue of its run.
- `waiting-marker`: A run parked on a signal carries the waiting marker.
- `waiting-not-stalled`: The checker counts runs parked on a signal as waiting, not as stalled.
- `waiting-run-left-alone`: The janitor creates no task for a run that waits on a signal.
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

### Worker kill (engine)

Two worker processes each take a task and are stopped with SIGKILL at a random point (before the step result is recorded, after it, or after the run finished but before the ack). A janitor reclaims their leases and two fresh workers finish every run.

Fidelity: Real operating system processes and a real signal. The kill lands only at the three checkpoints of the sample flow, not at an arbitrary instruction.

Seeds: 101000 to 101009.

### Database connection loss and recovery (engine)

The workers reach Postgres through a TCP proxy. At the checkpoints of the flow the proxy destroys every open connection, refuses the next reconnects, or lets a commit execute while swallowing its answer, so the worker cannot tell whether the transaction applied. A janitor reclaims what the workers could not nack.

Fidelity: The connections really die and pg really has to reconnect, but Postgres itself keeps running; a restarted server is not simulated.

Seeds: 102000 to 102009.

### Double delivery (engine)

Every task is leased, its visibility timeout expires, and it is delivered again, two to four times in all. Every delivery then runs concurrently, with random pauses between the steps of the handler, and each acks with its own lease token.

Fidelity: Real concurrent handlers over the real recorder and queue; the deliveries come from a moved clock rather than from a worker that really stalled.

Seeds: 103000 to 103009.

### Clock shifted forward and backward (engine)

Four runs wait on durable timers of 10 to 13 minutes and two runs have pending step tasks, one of them leased by a worker that vanished. The shared clock is moved backward and forward by minutes to hours several times, with two timer schedulers and a janitor ticking after every move, then jumps two days ahead.

Fidelity: The clock is an injected source, which is how every component reads time; the operating system clock is not changed.

Seeds: 104000 to 104009.

### Slow disk (engine)

Every insert, update, delete and commit takes 8 to 27 ms. Three workers with a 40 ms visibility timeout and a 15 ms heartbeat compete for eight runs, so leases expire in the middle of slow transactions and tasks are delivered to a second worker while the first is still writing.

Fidelity: The delay is added in front of write statements by a wrapper around the pool; the real disk and the real fsync are unchanged, and Postgres sees ordinary statements that arrive later.

Seeds: 105000 to 105009.

### Network latency (engine)

The workers reach Postgres through a TCP proxy that delays every packet in both directions by 2 to 9 ms, with bursts of 150 ms at some checkpoints. Two workers with an 80 ms visibility timeout and a 25 ms heartbeat compete for six runs, so heartbeats arrive late and leases are lost.

Fidelity: The delay is real packet delay on a local TCP connection; bandwidth limits, packet loss and reordering across hosts are not simulated.

Seeds: 106000 to 106009.

### Slow attempt racing a retry (engine)

Three runs each start a step whose first attempt hangs on a gate while an engine holds its lease. A second engine whose clock runs ten minutes ahead sees the lease as expired, takes the task and finishes the step. The gate then opens and the first attempt ends late, with a wrong result on odd repetitions and with an error on even ones.

Fidelity: Two real engines over one database. The expired lease comes from the clock of the second engine, not from a worker that really stalled, and the first attempt ignores its abort signal on purpose.

Seeds: 107000 to 107009.

### Two queues on one database (engine)

Two pairs of engines serve two queues, each queue with its own workflow types, on one database and one shared clock. Each queue has doubling runs and a sleeping run, and one workflow task of each queue is deleted before the engines start. The clock is moved forward until the janitor of each queue has recovered its own lost task.

Fidelity: Real engines and a real janitor per queue. A task that reached the wrong queue would meet an engine that does not know its workflow type and park, which the queue check and the convergence check both catch.

Seeds: 108000 to 108009.

### Clock skew between workers (engine)

Three engines on one queue read clocks that differ by 90 seconds in both directions while the visibility timeout is 30 seconds, so each sees the leases of the others as expired or as far in the future. All three clocks advance together, and the runs include two durable sleeps. Steps pause for a few milliseconds so deliveries overlap.

Fidelity: Each engine has its own injected clock source, which is how every engine component reads time; the operating system clocks are not changed, and the database clock stays the one truth for components that use it.

Seeds: 109000 to 109009.

### Pool smaller than concurrency (engine)

Two engines each run six tasks at a time over a pool of two connections, so every task, heartbeat and loop tick competes for a connection. Sixteen runs must finish with no engine error that is not recovered.

Fidelity: Real connection pools with a real wait queue. The pressure is structural (six workers over two connections); the suite does not measure how long the waits last.

Seeds: 110000 to 110009.

### Runs waiting on a signal (engine)

Six runs park on a signal next to two ordinary runs. While they wait, the invariant checker must count them as waiting and not as stalled, and the clock moves forty minutes forward so the janitor sweeps again and again without recovering them. The signals then arrive in a random order and every run must complete with its payload.

Fidelity: Real engines and the real waiting marker of the decision loop. The wait lasts a few hundred real milliseconds and many virtual minutes; a run that waits for days is the same row for longer.

Seeds: 111000 to 111009.

## Violations

None.

## Limits

- Zero violations over ten repetitions is evidence, not proof. The workloads are small (the sample flow and a timer flow) and the fault points are the ones the harness knows about.
- A run that carries the waiting marker is reported as waiting, never as stalled, so the checker cannot tell a signal that will never come from one that is late; the signal-wait scenario sends every signal itself.
- The engine runtime scenarios use workflows with one step, one sleep or one signal wait. Child workflows, continue-as-new and compaction are not part of the chaos workloads.
- Slow disk and network latency are simulated in front of Postgres, not inside it. A real fsync stall, a full disk or a restarted server are not covered.
- Timings depend on the machine; the faults are seeded, the interleaving of the operating system scheduler is not.
