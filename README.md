# AWTY (Are We There Yet?)

AWTY runs long tasks in the background and reports their progress in real time. A client submits a task, gets an id back immediately, and follows the task over a WebSocket until it finishes.

It is built with NestJS, TypeORM, PostgreSQL and pg-boss. PostgreSQL is the only infrastructure: it stores task state, holds the job queue, and carries progress events from workers to API instances.

The reasoning behind the design is in [docs/adr/architecture.md](docs/adr/architecture.md).

## Quick start

```bash
docker compose up --build
```

This starts PostgreSQL, applies the migrations, then starts the API on http://localhost:3000 and four worker processes. The first build takes a minute or two.

Try it:

```bash
npm install
npm run demo -- 10        # create a 10 second task and follow it
npm run test:e2e          # run automated test suite (37 tests across 6 phases)
```

The demo client renders an interactive terminal progress bar with elapsed time, status badges, and a completion summary card. Run `npm run demo -- --watch <taskId>` in a second terminal to see two clients follow the same task concurrently, or pass `--raw` for raw JSON protocol frames.

The same thing with curl:

```bash
curl -s -X POST localhost:3000/tasks -H 'content-type: application/json' -d '{"duration": 10}'
# {"id":"01a1...","status":"pending"}
curl -s localhost:3000/tasks/01a1...
# {"id":"01a1...","status":"processing","progress":40}
```

To see tasks fail, uncomment `SIMULATED_FAILURE_RATE` in `docker-compose.yml` and run `docker compose up` again.

### Without Docker

You need Node.js 22.13 or newer and PostgreSQL 13 or newer.

```bash
cp .env.example .env      # set DATABASE_URL
npm ci
npm run build
npm run migrate           # tasks table, pg-boss tables, queues
npm run start:api         # terminal 1
npm run start:worker      # terminal 2, and as many more as you like
```

Every worker process takes jobs from the same queue, so starting more of them adds capacity. `npm run dev:api` and `npm run dev:worker` run the same processes in watch mode.

## HTTP API

### POST /tasks

```http
POST /tasks
Content-Type: application/json

{ "duration": 10 }
```

`duration` is the number of seconds the task takes. It must be a whole number from 1 to 3600.

```http
HTTP/1.1 201 Created
Location: /tasks/01a1...

{ "id": "01a1...", "status": "pending" }
```

The request returns as soon as the task is stored and queued. It never waits for the task to run.

| Status | When                                                               |
| ------ | ------------------------------------------------------------------ |
| 201    | Task accepted                                                      |
| 400    | Body is missing or `duration` is not a whole number from 1 to 3600 |
| 500    | PostgreSQL is not reachable                                        |

Error bodies use Nest's standard shape, for example `{"statusCode":400,"error":"Bad Request","message":["duration must be at most 3600 seconds"]}`.

### GET /tasks/:id

```http
GET /tasks/01a1...

{ "id": "01a1...", "status": "processing", "progress": 40 }
```

| status       | progress                                   |
| ------------ | ------------------------------------------ |
| `pending`    | 0. Waiting for a worker                    |
| `processing` | 0 to 99, the last value the worker saved   |
| `completed`  | 100                                        |
| `failed`     | The last progress saved before the failure |

An unknown id, or an id that is not a UUID, returns 404.

### Health

- `GET /health/live` returns 200 while the process is running.
- `GET /health/ready` returns 200 when PostgreSQL answers and the event listener is connected, and 503 otherwise. Docker Compose uses it as the API health check.

## WebSocket API

Connect to `ws://localhost:3000/ws`, then subscribe to a task:

```json
{ "type": "subscribe", "taskId": "01a1..." }
```

The server sends these messages:

```json
{ "type": "progress", "taskId": "01a1...", "progress": 25 }
{ "type": "completed", "taskId": "01a1..." }
{ "type": "failed", "taskId": "01a1..." }
{ "type": "error", "taskId": "01a1...", "message": "Task not found" }
```

`progress` and `completed` are the messages from the task description. `failed` has the same shape as `completed`. `error` answers a client message the server rejected, and `taskId` is left out when the error is not about one task.

A client can also send `{ "type": "unsubscribe", "taskId": "..." }`.

An example session for a 5 second task:

```text
-> {"type":"subscribe","taskId":"01a1..."}
<- {"type":"progress","taskId":"01a1...","progress":0}
<- {"type":"progress","taskId":"01a1...","progress":20}
<- {"type":"progress","taskId":"01a1...","progress":40}
<- {"type":"progress","taskId":"01a1...","progress":60}
<- {"type":"progress","taskId":"01a1...","progress":80}
<- {"type":"completed","taskId":"01a1..."}
```

Rules the server follows:

- Subscribing always returns the current state straight away: `progress` for a pending or running task (0 while it waits), `completed` or `failed` for a finished one. That is the whole reconnect mechanism, see below.
- Progress only goes up. A client never sees a lower value than one it already received.
- The final message (`completed` or `failed`) is sent once. After it, the server forgets the subscription.
- Any number of clients can subscribe to the same task and all of them receive every update.
- Tasks run whether or not anyone is subscribed.
- A task reports at most once per second, and at most 100 times in total.
- A bad message gets an `error` and the connection stays open: invalid JSON, a message of another shape, a binary frame, a task id that is not a UUID, an unknown task, or more than 100 subscriptions on one connection.

### Reconnecting

When a connection drops, open a new one and send `subscribe` again for each task that has not finished. The reply is the current state, and updates continue from there. A client that was away for a while skips the progress values it missed, which is fine because progress is a state and not a log.

`scripts/demo-client.mjs` does this with exponential backoff and jitter. Close code `1001` means the server is shutting down, so reconnect to another instance or retry shortly.

### Limits and close codes

| Limit                        | Value                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Message size                 | 4 KiB                                                                                            |
| Messages per client          | burst of 50, then 25 per second. Beyond that the connection closes with `1008`                   |
| Subscriptions per connection | 100                                                                                              |
| Dead connection detection    | the server pings every 30 seconds and drops clients that do not answer                           |
| Slow client                  | progress is skipped while more than 512 KiB is queued, and the connection is dropped above 1 MiB |

## How it works

```text
                 POST /tasks                              LISTEN awty_task_events
  client ------------------> API ----+                +-----------------------> API ---- WebSocket ---> clients
                                     |  one           |
                                     v  transaction   |  NOTIFY, sent in the same
                              +---------------+       |  transaction as the change
                              |  PostgreSQL   |       |
                              |  tasks table  | <-----+----- worker x N
                              |  pg-boss jobs |   claim, progress, complete
                              +---------------+
```

1. `POST /tasks` inserts the task row and the pg-boss job in one transaction. Either both exist or neither does.
2. A worker fetches jobs from the queue and claims the task. The claim increments an `attempt` counter, which fences every later write by that worker.
3. The worker runs the task as a timer. Every second (or every 1 percent for tasks longer than 100 seconds) it reports progress. Reports are collected and written in batches every 250 ms, and each batch sends one NOTIFY in the same statement.
4. Every API instance listens for those notifications and forwards them to the WebSocket clients subscribed to the task.
5. At the end the worker marks the task completed and the job done.

### Failure handling

| What goes wrong                                              | What happens                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A worker crashes or is killed                                | It stops refreshing its heartbeat. After the expiry window (30 second heartbeat plus 30 second grace period, plus up to 10 seconds for the next check) the queue retries the job. Another worker claims the task and continues from the last saved progress. Downtime does not count toward the duration. |
| A worker is stopped gracefully (SIGTERM)                     | It saves progress and hands its jobs back. Another worker continues a few seconds later.                                                                                                                                                                                                                  |
| A worker pauses for a long time and comes back               | Its claim is gone. The next write is refused because of the attempt fence and it stops without changing anything.                                                                                                                                                                                         |
| A job runs out of attempts (5 by default)                    | The queue moves it to a dead letter queue. A worker marks the task `failed` and notifies subscribers.                                                                                                                                                                                                     |
| The task itself fails                                        | The task becomes `failed`, subscribers get `failed`, and the job is finished without retries. Use `SIMULATED_FAILURE_RATE` to see it.                                                                                                                                                                     |
| A worker finishes the task but dies before finishing the job | The retry finds the task already completed and finishes the job.                                                                                                                                                                                                                                          |
| The API restarts                                             | Task state is in PostgreSQL. Clients reconnect and subscribe again.                                                                                                                                                                                                                                       |
| The event connection drops or a notification is lost         | The API reconnects with backoff and, every 10 seconds and after each reconnect, compares each followed task with the database and sends what changed.                                                                                                                                                     |

### Several workers

Each task is processed by one worker at a time. pg-boss hands a job to a single consumer, and the `attempt` fence in the tasks table covers the cases where that is not enough, such as a worker that was declared dead but is still running. A worker holds up to 1000 tasks at once (`WORKER_CONCURRENCY`) because a running task is only a timer. Tasks never wait on each other. A new task starts within one poll interval (about 0.5 seconds) while capacity is free.

## Configuration

All settings are environment variables. The full list with defaults is in [.env.example](.env.example). The ones you are most likely to change:

| Variable                  | Default     | Meaning                                                               |
| ------------------------- | ----------- | --------------------------------------------------------------------- |
| `DATABASE_URL`            | none        | PostgreSQL connection string. Required                                |
| `WORKER_CONCURRENCY`      | 1000        | Tasks one worker process runs at once                                 |
| `TASK_HEARTBEAT_SECONDS`  | 30          | How long a silent worker keeps its tasks. Minimum 10                  |
| `TASK_MAX_ATTEMPTS`       | 5           | Attempts before a task is marked failed. Applied by `npm run migrate` |
| `TASK_RETENTION_DAYS`     | 7           | Finished tasks are deleted after this many days                       |
| `SIMULATED_FAILURE_RATE`  | 0           | Chance from 0 to 1 that an attempt fails on purpose                   |
| `LOG_LEVEL`, `LOG_PRETTY` | info, false | Logs are JSON on stdout. `LOG_PRETTY=true` is easier to read locally  |

## Commands

| Command                                                    | What it does                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run build`                                            | Compile TypeScript to `dist/`                                                    |
| `npm run migrate`                                          | Create or update the schema and queues using compiled JavaScript                 |
| `npm run dev:migrate`                                      | Run migrations directly with Nest CLI (no prior build step needed)               |
| `npm run start:api`                                        | Start the API HTTP & WebSocket server                                            |
| `npm run start:worker`                                     | Start a background worker process                                                |
| `npm run dev:api`                                          | Start the API server in watch mode (auto-reload on change)                        |
| `npm run dev:worker`                                       | Start a worker in watch mode (auto-reload on change)                             |
| `npm run demo -- 10`                                       | Create a 10-second task and follow its progress with a live terminal UI          |
| `npm run demo -- --watch <taskId>`                         | Follow an existing task without creating a new one (supports `--raw`)            |
| `npm run demo -- --help`                                   | Show all demo client flags (`--watch`, `--url`, `--raw`, `--no-color`)            |
| `npm run load-test -- --tasks 3000 --duration 20`          | Load generator that tests throughput and WebSocket delivery                      |
| `npm run test:e2e`                                         | Automated end-to-end test suite verifying all 6 phases, edge cases & failure modes |
| `npm run format`                                           | Format code with Prettier                                                        |
| `npm run lint`                                             | Check code with ESLint                                                           |

## Project layout

```text
src/
  main.api.ts, main.worker.ts, main.migrate.ts   entry points (HTTP and WebSocket, worker, schema)
  config/        environment variables, validated once at startup
  database/      TypeORM setup and the SQL migration for the tasks table
  tasks/         HTTP controller, service, repository (all SQL), entity, store interfaces
  queue/         pg-boss setup, producer, consumer adapter, transaction adapter, queue settings
  worker/        task processor, job consumer, progress batcher, dead letter and purge handlers
  events/        the NOTIFY payload format
  realtime/      WebSocket server, sessions, subscription registry, listener, reconciler
  health/        liveness and readiness
  common/        ids, clock, token bucket, chunking, logging
scripts/         demo client, load generator, and automated E2E test suite
docs/adr/        architecture decision record
```

For a file-by-file breakdown of each module and where to make changes, see [docs/codebase.md](docs/codebase.md).

