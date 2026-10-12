# Codebase Guide: Modules & Files

This guide explains the files in the AWTY project. It is written in simple English to help you understand what each file does and where to make changes when you want to update the project.

---

## Big Picture: How the System Works

AWTY runs in three different ways:
1. **API Server (`src/main.api.ts`)**: Handles web requests (HTTP) to create or check tasks, and runs a WebSocket server to send live progress updates to users.
2. **Worker (`src/main.worker.ts`)**: Runs in the background. It takes tasks from the queue, runs them, updates their progress, and handles retries if something goes wrong.
3. **Migration Runner (`src/main.migrate.ts`)**: Sets up the database tables and job queues before the app starts.

```text
src/
├── tasks/        # Task web routes, business logic, and database queries
├── worker/       # Background task runner, queue reader, and progress sender
├── realtime/     # WebSocket server and live updates
├── queue/        # pg-boss job queue setup and tools
├── database/     # Database setup and migration files
├── config/       # Settings and environment variables
├── events/       # Message format for live progress events
├── health/       # Health check routes (is the app healthy?)
├── common/       # Helper tools used across the app (clock, rate limit, id check)
└── scripts/      # Demo tool and load testing tool
```

---

## Detailed File Guide

### 1. `src/tasks/`: Tasks, Web Routes & Database

This folder handles task data, the HTTP web routes, and saving tasks to PostgreSQL.

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`tasks.controller.ts`](../src/tasks/tasks.controller.ts) | Receives web requests: `POST /tasks` (creates a new task) and `GET /tasks/:id` (returns task progress). | To add new web routes, change URL paths, or change HTTP response status codes. |
| [`tasks.service.ts`](../src/tasks/tasks.service.ts) | The main logic for tasks. Creates the task and the background job in one database step. Also looks up tasks by ID. | To change how tasks are created, change ID generation, or change error rules. |
| [`tasks.repository.ts`](../src/tasks/tasks.repository.ts) | Runs raw SQL queries to save tasks, claim tasks for workers, batch update progress, and delete old tasks. | To change SQL queries, change table columns, or speed up database writes. |
| [`entities/task.entity.ts`](../src/tasks/entities/task.entity.ts) | Defines the `tasks` table columns for TypeORM (`id`, `status`, `durationSeconds`, `progress`, etc.). | To add new columns or change existing columns in the `tasks` table. |
| [`dto/request/create-task.dto.ts`](../src/tasks/dto/request/create-task.dto.ts) | Checks incoming `POST /tasks` data. Makes sure `duration` is a whole number between 1 and 3600. | To change duration limits (e.g. allow longer tasks) or add new fields to the request body. |
| [`task.types.ts`](../src/tasks/task.types.ts) | Defines TypeScript types and statuses: `'pending'`, `'processing'`, `'completed'`, `'failed'`. | To add a new task status or change default duration numbers. |
| [`task-queue.ts`](../src/tasks/task-queue.ts) | A TypeScript interface that describes how to add a job to the queue. | To change the rules for how jobs enter the queue. |
| [`task-state-reader.ts`](../src/tasks/task-state-reader.ts) | A TypeScript interface for reading task status from the database without modifying anything. | To add new read-only queries for task status. |
| [`worker-task-store.ts`](../src/tasks/worker-task-store.ts) | A TypeScript interface that lists what database actions a worker can perform (claim, save progress, complete, fail). | To add new actions that workers can do on tasks in the database. |
| [`tasks.module.ts`](../src/tasks/tasks.module.ts) | NestJS module file that connects the task controller, service, and queue together for the API app. | To add new services or controllers to the task module. |
| [`tasks-store.module.ts`](../src/tasks/tasks-store.module.ts) | Shared module that gives database access to both the API app and the Worker app. | To change how database tools are shared across apps. |

---

### 2. `src/worker/`: Background Task Runner

This folder contains the code that runs background tasks, reports progress, and recovers from errors.

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`task-processor.ts`](../src/worker/task-processor.ts) | Runs each task. In this project, it waits using a timer to simulate work, and sends progress ticks. | **To put your real work here** (for example: image processing, report generation, or data imports) instead of simulated waiting. |
| [`task-consumer.ts`](../src/worker/task-consumer.ts) | Grabs jobs from the queue in batches (up to 50 at a time) and keeps jobs alive with heartbeats every 10 seconds. | To change how many jobs a worker fetches at once, or change how often heartbeats are sent. |
| [`progress-reporter.ts`](../src/worker/progress-reporter.ts) | Collects progress updates in memory and saves them in batches to PostgreSQL every 250 ms. | To change how often progress is saved to the database or change batch sizes. |
| [`dead-letter-handler.ts`](../src/worker/dead-letter-handler.ts) | Handles jobs that failed too many times. Marks the task as `failed` in the database and sends an event. | To add custom alerts when tasks fail (like sending an email or Slack alert). |
| [`purge-handler.ts`](../src/worker/purge-handler.ts) | Automatically deletes finished tasks that are older than 7 days to keep the database clean. | To change how long tasks are kept (retention period) or how many are deleted at once. |
| [`worker-lifecycle.ts`](../src/worker/worker-lifecycle.ts) | Starts and stops the worker cleanly. Handles shutdown signals (SIGTERM) without dropping tasks. | To add cleanup tasks when a worker stops or runs extra startup jobs. |
| [`worker-runtime.module.ts`](../src/worker/worker-runtime.module.ts) | Connects all worker services together in NestJS. | To change worker setup options or add new worker tools. |
| [`active-runs.ts`](../src/worker/active-runs.ts) | Keeps track of all tasks currently running on this worker process. | To see or cancel running tasks inside the worker. |
| [`fault-injector.ts`](../src/worker/fault-injector.ts) | Simulates random failures for testing when `SIMULATED_FAILURE_RATE` is set. | To test how the system recovers when workers crash. |
| [`progress.ts`](../src/worker/progress.ts) | Simple math formulas that calculate how often to send progress and what percentage is done. | To change how progress percentages are calculated. |
| [`abort-reasons.ts`](../src/worker/abort-reasons.ts) | Simple text labels for why a task was stopped (like worker shutdown or another worker took over). | To add new reasons for stopping a task. |

---

### 3. `src/realtime/`: WebSocket Live Updates

This folder manages WebSocket connections and sends live updates to users.

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`realtime.server.ts`](../src/realtime/realtime.server.ts) | Starts the WebSocket server on `/ws`. Handles new connections, checks message rate limits, and pings clients every 30 seconds. | To change the `/ws` URL, change rate limits, or change ping timers. |
| [`client-session.ts`](../src/realtime/client-session.ts) | Manages one connected user. Tracks what tasks the user wants to watch. Drops messages if a slow client falls too far behind. | To change how many tasks one user can watch (max 100), or adjust buffer size for slow users. |
| [`subscription-registry.ts`](../src/realtime/subscription-registry.ts) | Keeps a list of which users are watching which tasks. Makes sure progress never goes backwards, and forgets tasks when they finish. | To change how updates are sent out to multiple users. |
| [`task-events.listener.ts`](../src/realtime/task-events.listener.ts) | Listens to PostgreSQL `LISTEN awty_task_events`. When workers send updates, this picks them up immediately and forwards them to users. | To change the PostgreSQL channel name or reconnect settings. |
| [`reconciler.ts`](../src/realtime/reconciler.ts) | A safety check. Queries the database every 10 seconds to make sure no client missed an update during network drops. | To change how often the safety check runs. |
| [`protocol.ts`](../src/realtime/protocol.ts) | Defines what messages look like (like `subscribe`, `progress`, `completed`, `failed`). Uses Zod to check format. | To add new WebSocket message types or change what fields are sent to the client. |
| [`realtime.module.ts`](../src/realtime/realtime.module.ts) | Connects all real-time services together in NestJS. | To add new real-time components or change dependencies. |

---

### 4. `src/queue/`: pg-boss Job Queue Setup

This folder sets up and connects pg-boss (the job queue in PostgreSQL).

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`pg-boss-task-queue.ts`](../src/queue/pg-boss-task-queue.ts) | Sends new jobs into pg-boss inside the same database transaction as the task itself. | To change job options when creating a task. |
| [`pg-boss-job-source.ts`](../src/queue/pg-boss-job-source.ts) | Helper used by workers to fetch, touch, finish, and fail jobs in pg-boss. | To change how workers talk to pg-boss. |
| [`typeorm-db.ts`](../src/queue/typeorm-db.ts) | A small helper that lets pg-boss run inside TypeORM database transactions. | Only if you change how database connections or transactions work. |
| [`queue-setup.ts`](../src/queue/queue-setup.ts) | Creates and configures the 3 queues: `awty-tasks` (main queue), `awty-tasks-dlq` (failed jobs), and `awty-tasks-purge` (cleanup). | To change queue names, retry delays, or retry limits. |
| [`job-options.ts`](../src/queue/job-options.ts) | Sets how long a job has before it expires (60 seconds) and how many retries it gets (5 retries). | To change job timeout times or maximum retry attempts. |
| [`pg-boss.factory.ts`](../src/queue/pg-boss.factory.ts) | Starts pg-boss with the right connection pool settings for API, Worker, or Migration runner. | To adjust database connection pool sizes for pg-boss. |
| [`queue.constants.ts`](../src/queue/queue.constants.ts) | Stores queue name constants (`awty-tasks`, `awty-tasks-dlq`, `awty-tasks-purge`). | To rename queues or change queue tokens. |
| [`queue.module.ts`](../src/queue/queue.module.ts) | NestJS module that provides pg-boss tools to the app. | To change queue dependency setup. |

---

### 5. `src/database/`: Database Setup & Migrations

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`migrations/1760000000000-CreateTasksTable.ts`](../src/database/migrations/1760000000000-CreateTasksTable.ts) | The SQL file that creates the `tasks` table with rules and indexes. | When you need to change the database structure, add a new migration here. |
| [`data-source-options.ts`](../src/database/data-source-options.ts) | Sets up the TypeORM database connection options (URL, pool size, SSL). | To change database driver options or connection pooling. |
| [`database.module.ts`](../src/database/database.module.ts) | Connects TypeORM to the app. | To change how TypeORM starts up. |

---

### 6. `src/config/`: Configuration & Environment Settings

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`app-config.ts`](../src/config/app-config.ts) | Reads and checks all environment variables (like `DATABASE_URL`, `HTTP_PORT`, `WORKER_CONCURRENCY`) when the app starts. | **To add a new setting or environment variable**, or change default values. |
| [`config.module.ts`](../src/config/config.module.ts) | Makes settings available everywhere in the app. | To change how settings are shared. |

---

### 7. `src/common/`: Shared Tools

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`chunk.ts`](../src/common/chunk.ts) | Splits a big list into smaller pieces (chunks) for batch updates. | To change list chunking helper logic. |
| [`clock.ts`](../src/common/clock.ts) | Gets the current time using a timer that never shifts or goes backwards. | To mock time in tests or add custom timing helpers. |
| [`token-bucket.ts`](../src/common/token-bucket.ts) | Limits how fast users can send WebSocket messages to protect the server from spam. | To change rate limit math. |
| [`uuid.ts`](../src/common/uuid.ts) | Checks if a text string is a valid UUID format. | To change ID format checks. |
| [`logging.module.ts`](../src/common/logging.module.ts) | Sets up fast JSON logs with Pino, creates request IDs, and hides noisy health check logs. | To customize how logs look or add custom log details. |

---

### 8. `src/events/` & `src/health/`

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`task-event.ts`](../src/events/task-event.ts) | Defines the short message format used when PostgreSQL notifies the API about progress (`[taskId, status, progress]`). | To change what data is sent through PostgreSQL NOTIFY. |
| [`health.controller.ts`](../src/health/health.controller.ts) | Health check routes: `GET /health/live` (says 200 OK if server is on) and `GET /health/ready` (checks if database and listener are working). | To add new readiness checks. |
| [`health.module.ts`](../src/health/health.module.ts) | Connects health routes to NestJS. | To add new health check tools. |

---

### 9. `scripts/`: Helper Scripts

| File | What it does | When to edit this file |
| :--- | :--- | :--- |
| [`demo-client.mjs`](../scripts/demo-client.mjs) | Terminal demo tool. Lets you start a task (`npm run demo -- 10`) or watch an existing task (`npm run demo -- --watch <taskId>`). | To change how the terminal demo displays progress. |
| [`load-test.mjs`](../scripts/load-test.mjs) | Heavy load testing tool. Creates thousands of tasks and connects many WebSockets to measure speed and reliability. | To change load test settings (number of tasks, number of clients, or test duration). |

---

## "Where Do I Make Changes?" Cheat Sheet

When you want to change something, find your goal here:

| If you want to... | Edit these files |
| :--- | :--- |
| **Replace fake waiting with real task work** | `src/worker/task-processor.ts` |
| **Change the allowed task duration (currently 1 to 3600 seconds)** | `src/tasks/task.types.ts`, `src/tasks/dto/request/create-task.dto.ts`, and database migrations |
| **Add a new field to tasks (e.g. `title`, `userId`, `priority`)** | `src/tasks/entities/task.entity.ts`, `src/tasks/dto/request/create-task.dto.ts`, `src/tasks/tasks.repository.ts`, and add a new migration in `src/database/migrations/` |
| **Change how often workers save progress to the database** | Change `PROGRESS_FLUSH_INTERVAL_MS` in `.env` / `src/config/app-config.ts`, or edit `src/worker/progress-reporter.ts` |
| **Change how many tasks one worker runs at the same time** | Change `WORKER_CONCURRENCY` in `.env` / `src/config/app-config.ts` |
| **Change worker timeout or retry count** | Change `TASK_HEARTBEAT_SECONDS` / `TASK_MAX_ATTEMPTS` in `.env` / `src/config/app-config.ts` and `src/queue/queue-setup.ts` |
| **Change WebSocket message size or rate limits** | `src/realtime/realtime.server.ts` |
| **Add a new WebSocket message type** | `src/realtime/protocol.ts` and `src/realtime/client-session.ts` |
| **Add or change web routes (HTTP)** | `src/tasks/tasks.controller.ts` and `src/tasks/tasks.service.ts` |
| **Change health check rules** | `src/health/health.controller.ts` |
| **Add a new environment setting** | `src/config/app-config.ts` and `.env.example` |
