# ADR: Architecture of AWTY

## Context

AWTY receives a task with a duration, returns a task ID immediately, runs the task in the background, and sends live progress updates to WebSocket clients until the task is done.

The design is based on these requirements:

- Tasks run in the background using pg-boss. The HTTP request returns right away and does not wait for the task to finish.
- Multiple worker processes can run at the same time. A task must never be run by two workers at the same time.
- State is saved safely. If a server or worker restarts, running tasks are not lost.
- If a client disconnects, they can reconnect and immediately get the current task state.
- If a task fails or a worker crashes, the task status is marked as `failed`. A crashed worker must never leave a task stuck in `processing` forever.
- Tasks run independently from each other.

The system is designed for high load: thousands of tasks running at the same time and thousands of connected WebSocket clients. This requirement explains three important design choices:

1. How progress updates are saved in batches.
2. How events are sent to WebSocket clients using PostgreSQL LISTEN/NOTIFY.
3. How a single worker can manage thousands of tasks at the same time.

In this project, the work is simulated (the task waits using timers). However, the system is designed like real work that takes time and can fail. If real work is needed later, only the code in `src/worker/task-processor.ts` needs to change.

## Decision summary

1. **PostgreSQL is the only infrastructure**: The `tasks` table stores task data, pg-boss manages the job queue, and PostgreSQL LISTEN/NOTIFY sends real-time events.
2. **One transaction for task and job**: Creating the task row in the database and creating the pg-boss job happen in a single database transaction. The job ID is the same as the task ID.
3. **Attempt counter protects worker writes**: Every task has an `attempt` counter. Workers include this counter in their updates so old or slow workers cannot overwrite newer data.
4. **Crash recovery and retries**: Worker crashes are detected using heartbeats. Failed jobs are retried with increasing delay (backoff). If a job uses all retries, a dead-letter queue marks the task as `failed`. A retry continues from the last saved progress.
5. **Time-based progress**: Progress is calculated from elapsed time, never goes backward, and is sent at most once per second.
6. **Batched progress updates**: Workers group progress updates and save them together every 250 ms. Each batch sends its NOTIFY event in the same database statement.
7. **Custom worker loop for the main queue**: Instead of using pg-boss `work()` (which creates a separate poller for each task), workers use `fetch`, `touch`, `complete`, and `fail`. This allows one worker process to manage thousands of tasks efficiently. The standard `work()` method is only used for low-traffic queues (dead-letter and cleanup).
8. **Real-time updates and reconnection**: When clients subscribe, they immediately receive the latest state. A background reconciler checks the database every 10 seconds to fix any missed events.
9. **Simple WebSocket protocol**: The WebSocket protocol uses the message formats from the project requirements. The server uses the `ws` library directly for better control over connections.
10. **Frameworks and libraries**: NestJS with Express handles HTTP requests. TypeORM manages basic database operations, while raw SQL handles complex updates. The `class-validator` library validates HTTP requests, and Zod validates environment settings and WebSocket messages.
11. **Single migration command**: Only `npm run migrate` can change the database schema. API and worker services cannot modify the database tables.
12. **Random IDs and cleanup**: Tasks use unguessable UUIDv4 IDs to stay secure and private. A background job regularly deletes old finished tasks after a set retention period.
13. **Testing and verification**: The system was tested and measured under heavy load against a live PostgreSQL 16 database using a custom load-test script.

## Decisions

### 1. PostgreSQL is the only infrastructure

All task data is stored in the `tasks` table. The pg-boss job is only used to tell workers to run the task; it does not store the task state itself. Progress updates are sent as NOTIFY messages through a single PostgreSQL channel.

**Why this choice was made**: Using only PostgreSQL means we have one system to manage and back up. We can update task data and queue jobs together in one atomic step (see Decision 2). There is no second database that could get out of sync with the first. The project instructions also specified PostgreSQL and pg-boss.

**Other options considered**: We could have used Redis for pub/sub events or task state. Redis is very fast for messaging, but it adds another service to deploy, monitor, and keep in sync with PostgreSQL. Redis should only be added if PostgreSQL NOTIFY becomes too slow under extreme load (see "Limits").

### 2. One transaction for the task and its job

When a client calls `POST /tasks`, the API opens a database transaction. Inside that transaction, it saves the task to the `tasks` table and tells pg-boss to add the job using `boss.send` with the same database connection (`src/queue/typeorm-db.ts`).

If either step fails, the database cancels the entire transaction. This means we will never have a task in the database without a queue job, and we will never have a queue job without a task row.

The job ID is set to match the task ID (using the `id` option in `send`). This ensures that the same task cannot be added twice, and any failed job in the dead-letter queue can easily be linked back to its task in the database.

**Other options considered**: Saving the task first and adding the job second without a transaction. If the server crashed between those two steps, the task would be stuck in `pending` forever and would require a separate cleanup script to fix.

### 3. Fencing with an attempt counter

When a worker starts working on a task, it claims it with an SQL update:
`UPDATE tasks SET attempt = attempt + 1 ... WHERE status IN ('pending', 'processing')`.

All later database updates by that worker (saving progress, marking completed, or marking failed) include this condition:
`WHERE id = $1 AND attempt = $2 AND status = 'processing'`.

If another worker takes over the task while the first worker is still running, the attempt number increases. When the first worker tries to save updates, the SQL query updates 0 rows. The old worker sees that nothing was updated, realizes it no longer owns the task, and stops working.

**Why this matters**: We cannot rely only on the queue to make sure only one worker runs a task. A worker might pause temporarily (for example, during Node.js garbage collection, high CPU usage, or network issues). If the queue thinks the worker died, it gives the task to a second worker. If the first worker wakes up later, its attempt number is now old, so the database rejects its writes. pg-boss uses the same method for its own commands (`complete`, `fail`, `touch`).

**Other options considered**: Database row locks (`SELECT ... FOR UPDATE`) held during the whole task. This would require keeping an open database connection for every running task, which does not scale when running thousands of tasks at the same time.

### 4. Crash recovery

- **Heartbeat monitoring**: Each job has a heartbeat time limit (`TASK_HEARTBEAT_SECONDS`, default 30 seconds). Every 10 seconds, a worker sends a heartbeat for all its active tasks in a single database query. If a worker stops sending heartbeats for the full window, the queue marks it as dead and gives the job to another worker.
- **Job expiry window**: Each job has an expiration window equal to the heartbeat plus a grace period (30s + 30s = 60 seconds by default). Active workers keep this window open by regularly updating their heartbeats.
- **Fast detection**: Workers check for stalled jobs every 10 seconds. With default settings, a killed worker (`kill -9`) is detected and retried in about 40 seconds.
- **Retries with backoff**: Each job has up to 5 attempts (`TASK_MAX_ATTEMPTS`). If an attempt fails, the queue waits before retrying, starting with a 2-second delay that increases exponentially. A graceful shutdown also consumes one attempt, which is why the default is 5 attempts rather than 3.
- **Resuming progress**: When a task is retried, the new worker starts from the last saved progress. Progress never goes backward, and work that was already done is not repeated. Downtime while waiting for a retry does not count toward task duration.
- **Dead-letter queue for exhausted jobs**: If a job fails all 5 attempts, pg-boss moves it to a dead-letter queue (`awty-tasks-dlq`). A background handler reads jobs from this queue, marks the task as `failed` in the database, and notifies subscribers. Without this handler, a task whose worker died on the final attempt would stay stuck in `processing`.
- **Final failures**: If a task fails because of an internal error or simulated failure, the failure is permanent. The worker marks the task as `failed` and marks the pg-boss job as complete so it is not retried. Retries are only for system crashes and network issues.
- **Safe completion**: Marking a task as completed is safe to repeat (idempotent). If a worker marks a task as `completed` in the database but crashes before telling pg-boss, the next retry sees that the task is already completed and simply finishes the queue job.

We chose 30 seconds for the heartbeat window to avoid false alarms under heavy load. If the database is busy for 10 seconds, workers should not be marked as dead by mistake. The window can be configured down to 10 seconds, which is the minimum supported by pg-boss.

### 5. Progress model

Progress is calculated as:
`floor(100 * time worked / total duration)`.

A task reports progress at most once per second. For long tasks (longer than 100 seconds), it reports once for every 1% increase. This means no task ever sends more than 100 updates. For example, a 10-second task reports 10, 20, 30... 90, and then completes.

The worker measures elapsed time with a monotonic clock (`src/common/clock.ts`) that never moves backward. If the Node.js event loop slows down temporarily, progress jumps ahead to match actual time rather than lagging behind. If a timer fires slightly early, the planned schedule is used.

### 6. Batched progress writes

If a worker is running thousands of tasks, updating the database for every task on every tick would create thousands of database transactions per second. This would overload PostgreSQL.

Instead, the `ProgressReporter` stores the latest progress for each task in memory. Every 250 ms, it writes all pending updates to the database in a single SQL query (up to 100 tasks per batch). This query updates the rows and triggers the `pg_notify` event in the exact same statement (`FLUSH_PROGRESS_SQL`).

**Benefits**:

- **Consistency**: The database row update and the event notification happen in the same transaction. Clients never receive an event for progress that was not saved to the database.
- **Low latency**: Clients receive progress updates within 250 ms of the actual tick. For tasks that report once per second, this small delay is not noticeable.
- **Resilience**: If the database is temporarily slow, the worker holds updates in memory and writes them once the database is ready.
- **Ownership detection**: If the database query does not update a row (because another worker took over the task), the worker immediately stops that task.

**Database efficiency**: Tasks table rows are updated frequently, so the table is created with `fillfactor = 70`. This leaves empty space on each disk page for updates. In performance tests, about 93% of updates were in-place (PostgreSQL HOT updates), which prevents the table from growing too large. In test runs, batches typically grouped 53 to 68 rows into each statement.

### 7. A custom consumer for the main queue

By default, pg-boss `work()` creates a separate polling loop and heartbeat timer for each active job. In our system, running a task is just waiting on a timer (it does not use heavy CPU). Therefore, a single worker process should be able to hold thousands of tasks at once. Using `work()` for thousands of tasks would create thousands of database queries and timers, which would waste resources.

To solve this, `TaskConsumer` (`src/worker/task-consumer.ts`) uses public pg-boss methods directly (`fetch`, `touch`, `complete`, and `fail`):

- **Single fetch loop**: The worker checks how many free task slots it has and fetches that many jobs in batches (up to 50 at a time). If the queue is empty, it waits about 0.5 seconds (with random jitter) before asking again.
- **Batch heartbeats**: A single background timer refreshes heartbeats for all active tasks in one query every 10 seconds.
- **Safe completion**: When finishing or failing a job, the worker includes the attempt number so an outdated worker cannot change the job.
- **Even load distribution**: When fetching multiple batches, the worker pauses for 25 ms between batches. The random jitter on the poll delay prevents all workers from polling the database at the exact same millisecond. In tests with 4 workers, tasks were shared almost equally.

The standard pg-boss `work()` method is still used for the dead-letter and cleanup queues, because those queues have very few jobs.

### 8. Real-time delivery

- **Notification channel**: Workers send events using `pg_notify` on the channel `awty_task_events`. Each message is a compact JSON array: `[taskId, eventType, progress]`.
- **Dedicated listener**: Each API instance maintains one dedicated database connection that runs `LISTEN awty_task_events`. When an event arrives, it passes it to a `SubscriptionRegistry`, which sends the message to connected WebSocket clients. Because LISTEN requires a persistent session, this connection must connect directly to PostgreSQL or through a session-mode pooler (not a transaction-mode pooler).
- **Monotonic progress rule**: The registry guarantees two rules for every subscriber:
  1. Progress only goes up; older or duplicate values are dropped.
  2. After sending a final event (`completed` or `failed`), the subscription is removed.
- **Race-free subscription**: A client registers its subscription in memory before reading the database state. If an update arrives while reading the database, it is not lost. If a newer update was already sent to the client, the older database snapshot is safely ignored.
- **Instant snapshot on subscribe**: When a client subscribes to a task, the server immediately looks up the current task state in the database and sends it. If a client disconnects and reconnects, subscribing again immediately restores their state. Progress represents current state rather than a full log, so clients only need the latest value (avoiding sequence numbers or message replay storage).
- **Automatic reconciliation**: PostgreSQL NOTIFY messages are not stored. If an API instance disconnects, it might miss events. To prevent lost updates, a background `Reconciler` runs every 10 seconds (and immediately after the listener reconnects). It checks the database for all currently subscribed tasks and sends any updates that were missed.
- **Fast listener reconnection**: If the database listener drops, it reconnects using backoff capped at 5 seconds so live updates resume quickly.

### 9. WebSocket protocol and server

The protocol supports four server message types matching the project specification:

- `progress`: sent during execution with the current progress percentage.
- `completed`: sent when the task finishes successfully.
- `failed`: sent if the task fails or runs out of retries (same format as `completed`).
- `error`: sent if the client sends an invalid request.

Clients can send `subscribe` and `unsubscribe` messages with a `taskId`. No unnecessary extra fields are added to any message.

Instead of NestJS WebSockets gateways (which expect messages keyed by `event` rather than `type`), the server uses the native `ws` library directly. This gives full control over connection limits, ping/pong heartbeats, backpressure, and graceful shutdown. The WebSocket server runs on the same HTTP port and handles connections at `/ws`.

**Protection against slow or malicious clients**:

- Message size is limited to 4 KiB.
- Rate limiting uses a token bucket per connection: allows bursts of up to 50 messages, then 25 messages per second. Exceeding this limit closes the connection with code `1008`.
- A connection can subscribe to at most 100 tasks at the same time.
- The server sends a ping every 30 seconds and terminates connections that do not reply with a pong.
- Backpressure handling: if a slow client has more than 512 KiB buffered, intermediate `progress` updates are skipped. If the buffer exceeds 1 MiB, the connection is closed. Terminal messages (`completed`, `failed`) are never skipped.
- On server shutdown, all connections are closed with code `1001` (Going Away).

### 10. Framework and libraries

- **NestJS with Express**: Uses NestJS with the default Express HTTP adapter. It provides clean dependency injection, modular organization, and standard request handling.
- **TypeORM**: Used for basic database interactions (connecting, running migrations, and simple inserts/reads). Complex queries (conditional updates with attempt checks, array `unnest` batch updates, and `pg_notify`) are written in clean raw SQL in `TasksRepository`.
- **Query runner result handling**: In TypeORM, `QueryRunner.query` returns `[rows, count]` for UPDATE/DELETE but returns plain rows for SELECT. To handle this consistently, `TasksRepository` asks for a structured result (`useStructuredResult = true`) and reads `records`.
- **TypeORM transaction adapter for pg-boss**: A short adapter function (`src/queue/typeorm-db.ts`, 18 lines) allows pg-boss to use TypeORM's database transaction so tasks and jobs are saved together atomically.
- **Validation**:
  - `class-validator` validates the HTTP request body (`CreateTaskDto`).
  - `zod` validates environment variables on startup and incoming WebSocket messages.
- **Logging**: `nestjs-pino` outputs structured JSON logs to standard output (stdout), attaching an `x-request-id` to every request.
- **Configuration**: Environment variables are validated once when the application starts (`src/config/app-config.ts`). If any setting is missing or invalid, the app stops immediately with a clear error message.

### 11. Schema ownership

Only the command `npm run migrate` is allowed to change database tables. It acquires an advisory lock (`7243001`), runs the TypeORM migrations for the `tasks` table, lets pg-boss create or update its own queue tables, and configures the queues.

API and worker containers start with migration privileges disabled. This prevents multiple containers from racing to change database schemas during a rolling deployment. In Docker Compose, a separate migration container runs first, and other services wait for it to finish.

The database table has check constraints for status values, progress range (0 to 100), duration limits, and ensuring `progress = 100` when status is `completed`.

### 12. IDs and retention

Task IDs are random UUIDv4 strings generated using Node's built-in `randomUUID()`. Because the IDs are random and unguessable, clients cannot guess or access other users' tasks.

If a client requests a task ID that is not a valid UUID format, the server returns 404 immediately without running a database query.

A background job (`PurgeHandler`) runs periodically to delete completed tasks older than `TASK_RETENTION_DAYS` (default 7 days). It deletes them in batches of 5000 to keep database load low. pg-boss automatically deletes its own finished jobs after 1 hour, since the `tasks` table is the permanent record.

### 13. Testing and verification

Verification relies on testing the full system against a live PostgreSQL 16 database.

A load-testing tool (`scripts/load-test.mjs`) tests the system under heavy load using only public HTTP and WebSocket APIs. It creates thousands of concurrent tasks, opens WebSocket subscriptions, verifies live progress updates, and confirms task completion.

## Failure modes

| Failure scenario                                       | Why tasks are not lost or stuck                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker crashes while running a task                    | Heartbeats stop. After the timeout, the queue gives the job to another worker. The new worker resumes from the last saved progress.                                             |
| Worker dies on its final attempt                       | The queue moves the job to the dead-letter queue. A handler marks the task as `failed` and notifies subscribers.                                                                |
| Crash between creating task and queueing job           | Not possible: both are saved together in a single database transaction.                                                                                                         |
| Worker pauses temporarily and resumes later            | The task attempt number was increased when another worker took over. The old worker's writes are rejected by the database, and it stops cleanly.                                |
| Worker completes task in DB but dies before ending job | When the job is retried, the new worker sees the task is already `completed` and simply finishes the queue job.                                                                 |
| API server restarts                                    | Task data is stored safely in PostgreSQL. Clients reconnect and subscribe again to receive the latest state.                                                                    |
| Notification event is lost                             | The background reconciler queries the database every 10 seconds and sends any missing progress updates to subscribers.                                                          |
| PostgreSQL is temporarily unavailable                  | The `/health/ready` endpoint returns 503; new task creation returns 500. Active workers keep their timers running in memory and retry database writes when PostgreSQL recovers. |

## Measured behavior

These tests were performed on a single virtual machine (1 vCPU, 4 GB RAM) running PostgreSQL 16, the API service, four worker processes, and the load generator at the same time:

| Scenario                                                                                                  | Result                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3,000 tasks of 20 s, created at ~150 per second, 4 workers, 150 WebSocket clients following 10 tasks each | All tasks completed 40 seconds after the first request (creation time plus duration). Median start delay was 0.2 s (95th percentile 0.4 s). Average run time was 20.02 s with zero retries. Every client received final completion events within 0.22 s of database commit. |
| Same scenario, but limiting workers to 250 task slots each (1,000 total slots) with 3,000 tasks of 10 s   | No failures. Tasks waiting for available slots stayed in `pending` (median wait 6 s). Work was shared equally: each worker handled exactly 750 tasks.                                                                                                                       |
| Progress writes during load tests                                                                         | Progress updates were batched into 53 to 68 rows per database statement. About 93% of updates were in-place (PostgreSQL HOT updates), keeping the database table healthy.                                                                                                   |
| Resource usage during the 3,000-task test                                                                 | The API used about 5 seconds of CPU time and 156 MB RAM. Each worker used about 1.5 seconds of CPU time and 126 MB RAM.                                                                                                                                                     |
| Worker killed with `kill -9` while holding the most tasks                                                 | Another worker took over after 39.8 seconds (with default 30s heartbeat). Progress never moved backward, and only tasks from the killed worker were retried.                                                                                                                |
| Worker stopped gracefully with SIGTERM                                                                    | The worker exited cleanly in 30 ms. Another worker picked up the tasks 3.3 seconds later.                                                                                                                                                                                   |
| All API and worker processes killed with `kill -9` and restarted                                          | All task data and progress remained safe in PostgreSQL. All tasks resumed and completed normally after restart.                                                                                                                                                             |
| PostgreSQL stopped for 12 seconds                                                                         | No application processes crashed. The `/health/ready` check returned 503. Once PostgreSQL recovered, all workers resumed saving progress and no tasks needed to restart.                                                                                                    |
| Task finished while PostgreSQL was temporarily stopped                                                    | The task completed successfully as soon as PostgreSQL reconnected, continuing from its last saved 91% progress.                                                                                                                                                             |
| Job exceeded maximum retry attempts                                                                       | The task was marked `failed` about 11 seconds after the final crash. Both HTTP and WebSocket APIs reported the failure correctly.                                                                                                                                           |
| Two API instances behind a load balancer                                                                  | A client connected to API instance A received live updates for a task created through API instance B without issues.                                                                                                                                                        |
