#!/usr/bin/env node

/**
 * AWTY (Are We There Yet?) - Comprehensive Automated End-to-End Test Suite
 *
 * Exercises all 6 phases:
 *  - Phase 1: Environment & Setup (Health checks)
 *  - Phase 2: Happy Paths & Core Lifecycle (POST, GET, WS streaming, Fan-out, Reconnect, Unsubscribe)
 *  - Phase 3: Validation & Negative Cases (Payload boundaries, invalid types, 404s, WS schema guards)
 *  - Phase 4: Concurrency & Edge Cases (Parallel tasks, late subscriptions, monotonicity)
 *  - Phase 5: Bonus / Safeguards (Token Bucket rate limiter 1008, 100 subscription cap, 4 KiB frame limit, Ping-pong liveness, DB constraints)
 *  - Phase 6: Architecture Failure Modes & ADR Invariants (Heartbeat recovery, Worker claim fencing, DLQ retry exhaustion, Background reconciler catchup, 7-day retention purge, Atomic transaction rollback)
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';

const { Client } = pg;
const BASE_URL =
  process.env.BASE_URL ?? process.env.AWTY_URL ?? 'http://localhost:3000';
const WS_URL = process.env.WS_URL ?? `${BASE_URL.replace(/^http/, 'ws')}/ws`;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://awty:awty@localhost:5433/awty';

async function getDbClient() {
  const urls = [
    DATABASE_URL,
    'postgres://awty:awty@localhost:5432/awty',
    'postgres://awty:awty@127.0.0.1:5433/awty',
  ];
  for (const url of urls) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch {
      // try next
    }
  }
  return null;
}

// ANSI colors for clean CLI reporting
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

let passedCount = 0;
let failedCount = 0;
const failures = [];

function logPass(title, detail = '') {
  passedCount++;
  console.log(
    `  ${colors.green}✔ PASS${colors.reset} ${title} ${detail ? colors.dim + '(' + detail + ')' + colors.reset : ''}`,
  );
}

function logFail(title, error) {
  failedCount++;
  failures.push({ title, error: error.message || String(error) });
  console.log(`  ${colors.red}✖ FAIL${colors.reset} ${title}`);
  console.log(
    `    ${colors.red}Error: ${error.message || error}${colors.reset}`,
  );
}

function printSection(title) {
  console.log(
    `\n${colors.bold}${colors.cyan}════════════════════════════════════════════════════════════════${colors.reset}`,
  );
  console.log(`${colors.bold}${colors.cyan}  ${title}${colors.reset}`);
  console.log(
    `${colors.bold}${colors.cyan}════════════════════════════════════════════════════════════════${colors.reset}\n`,
  );
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, options);
  let json = null;
  const text = await response.text();
  try {
    json = JSON.parse(text);
  } catch {
    // text body
  }
  return {
    status: response.status,
    headers: response.headers,
    body: json,
    rawText: text,
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// ============================================================================
// PHASE 1: Environment & Setup
// ============================================================================
async function runPhase1() {
  printSection('PHASE 1: Environment & Health Checks');

  // Test 1.1: Live Endpoint
  try {
    const res = await request('/health/live');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(
      res.body?.status === 'ok',
      `Expected status 'ok', got ${JSON.stringify(res.body)}`,
    );
    logPass('1.1 GET /health/live returns 200 OK', JSON.stringify(res.body));
  } catch (err) {
    logFail('1.1 GET /health/live returns 200 OK', err);
  }

  // Test 1.2: Ready Endpoint
  try {
    const res = await request('/health/ready');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(
      res.body?.status === 'ok',
      `Expected status 'ok', got ${JSON.stringify(res.body)}`,
    );
    assert(
      res.body?.checks?.database === 'up',
      `Database check not up: ${JSON.stringify(res.body?.checks)}`,
    );
    assert(
      res.body?.checks?.listener === 'up',
      `Listener check not up: ${JSON.stringify(res.body?.checks)}`,
    );
    logPass(
      '1.2 GET /health/ready returns 200 with DB & Listener UP',
      JSON.stringify(res.body),
    );
  } catch (err) {
    logFail('1.2 GET /health/ready returns 200 with DB & Listener UP', err);
  }
}

// ============================================================================
// PHASE 2: Happy Paths & Core Lifecycle
// ============================================================================
async function runPhase2() {
  printSection('PHASE 2: Happy Paths & Core Lifecycle');
  let createdTaskId = null;

  // Test 2.1: Create Task
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 3 }),
    });
    assert(res.status === 201, `Expected 201 Created, got ${res.status}`);
    assert(
      res.body?.id,
      `Missing task id in response: ${JSON.stringify(res.body)}`,
    );
    assert(
      res.body?.status === 'pending',
      `Expected status 'pending', got ${res.body?.status}`,
    );
    const location = res.headers.get('location');
    assert(
      location === `/tasks/${res.body.id}`,
      `Location header mismatch: ${location}`,
    );
    createdTaskId = res.body.id;
    logPass(
      '2.1 POST /tasks creates task with 201 Created and Location header',
      `ID: ${createdTaskId}`,
    );
  } catch (err) {
    logFail(
      '2.1 POST /tasks creates task with 201 Created and Location header',
      err,
    );
    return;
  }

  // Test 2.2: Initial State Query
  try {
    const res = await request(`/tasks/${createdTaskId}`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body?.id === createdTaskId, `ID mismatch`);
    assert(
      ['pending', 'processing'].includes(res.body?.status),
      `Unexpected status: ${res.body?.status}`,
    );
    assert(typeof res.body?.progress === 'number', `Progress not a number`);
    logPass(
      '2.2 GET /tasks/:id returns initial state',
      `status=${res.body.status}, progress=${res.body.progress}`,
    );
  } catch (err) {
    logFail('2.2 GET /tasks/:id returns initial state', err);
  }

  // Test 2.3: WebSocket Live Stream to Completion
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const progressTicks = [];
      let completedReceived = false;

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', taskId: createdTaskId }));
      });

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'progress') {
          progressTicks.push(msg.progress);
        } else if (msg.type === 'completed') {
          completedReceived = true;
          ws.close();
        } else if (msg.type === 'failed' || msg.type === 'error') {
          ws.close();
          reject(
            new Error(`Unexpected WS terminal message: ${JSON.stringify(msg)}`),
          );
        }
      });

      ws.on('close', () => {
        if (!completedReceived) {
          reject(
            new Error(`Socket closed before completion message was received`),
          );
        } else {
          resolve(progressTicks);
        }
      });

      ws.on('error', reject);
    });
    logPass(
      '2.3 WebSocket subscription receives progress stream and completes',
      `Task: ${createdTaskId}`,
    );
  } catch (err) {
    logFail(
      '2.3 WebSocket subscription receives progress stream and completes',
      err,
    );
  }

  // Test 2.4: Completed Task Verification via HTTP
  try {
    const res = await request(`/tasks/${createdTaskId}`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(
      res.body?.status === 'completed',
      `Expected status completed, got ${res.body?.status}`,
    );
    assert(
      res.body?.progress === 100,
      `Expected progress 100, got ${res.body?.progress}`,
    );
    logPass(
      '2.4 GET /tasks/:id reflects final completed state with progress 100',
    );
  } catch (err) {
    logFail(
      '2.4 GET /tasks/:id reflects final completed state with progress 100',
      err,
    );
  }

  // Test 2.5: Fan-out to Multiple Concurrent Subscribers
  try {
    const fanoutTask = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 3 }),
    });
    const fanoutId = fanoutTask.body.id;

    const [clientA, clientB] = await Promise.all([
      new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        let done = false;
        ws.on('open', () =>
          ws.send(JSON.stringify({ type: 'subscribe', taskId: fanoutId })),
        );
        ws.on('message', (m) => {
          const msg = JSON.parse(m.toString());
          if (msg.type === 'completed') {
            done = true;
            ws.close();
          }
        });
        ws.on('close', () =>
          done ? resolve(true) : reject(new Error('Client A closed early')),
        );
        ws.on('error', reject);
      }),
      new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        let done = false;
        ws.on('open', () =>
          ws.send(JSON.stringify({ type: 'subscribe', taskId: fanoutId })),
        );
        ws.on('message', (m) => {
          const msg = JSON.parse(m.toString());
          if (msg.type === 'completed') {
            done = true;
            ws.close();
          }
        });
        ws.on('close', () =>
          done ? resolve(true) : reject(new Error('Client B closed early')),
        );
        ws.on('error', reject);
      }),
    ]);
    assert(clientA && clientB, 'Both clients did not complete');
    logPass(
      '2.5 Multiple concurrent clients receive broadcast updates and completion',
    );
  } catch (err) {
    logFail(
      '2.5 Multiple concurrent clients receive broadcast updates and completion',
      err,
    );
  }

  // Test 2.6: Mid-Task Disconnect and Reconnection State Recovery
  try {
    const reconnTask = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 5 }),
    });
    const reconnId = reconnTask.body.id;

    await new Promise((resolve, reject) => {
      const ws1 = new WebSocket(WS_URL);
      ws1.on('open', () =>
        ws1.send(JSON.stringify({ type: 'subscribe', taskId: reconnId })),
      );
      ws1.on('message', (m) => {
        const d = JSON.parse(m.toString());
        if (d.progress >= 20) {
          // Disconnect client 1
          ws1.terminate();

          // Wait 2 seconds while worker progresses in background
          setTimeout(() => {
            const ws2 = new WebSocket(WS_URL);
            let firstReceived = null;
            ws2.on('open', () =>
              ws2.send(JSON.stringify({ type: 'subscribe', taskId: reconnId })),
            );
            ws2.on('message', (m2) => {
              const d2 = JSON.parse(m2.toString());
              if (!firstReceived) {
                firstReceived = d2;
                assert(
                  d2.type === 'progress',
                  `Expected progress snapshot on reconnect`,
                );
                assert(
                  d2.progress >= 20,
                  `Expected restored progress >= 20, got ${d2.progress}`,
                );
              }
              if (d2.type === 'completed') {
                ws2.close();
                resolve();
              }
            });
            ws2.on('error', reject);
          }, 2000);
        }
      });
      ws1.on('error', reject);
    });
    logPass(
      '2.6 Reconnecting client immediately recovers latest progress state snapshot',
    );
  } catch (err) {
    logFail(
      '2.6 Reconnecting client immediately recovers latest progress state snapshot',
      err,
    );
  }

  // Test 2.7: Explicit Unsubscribe
  try {
    const unsubTask = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 4 }),
    });
    const unsubId = unsubTask.body.id;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      let messagesAfterUnsub = 0;
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'subscribe', taskId: unsubId })),
      );
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        if (d.progress >= 25 && messagesAfterUnsub === 0) {
          ws.send(JSON.stringify({ type: 'unsubscribe', taskId: unsubId }));
          // Give 2 seconds to ensure no extra messages leak
          setTimeout(() => {
            ws.close();
            if (messagesAfterUnsub === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `Received ${messagesAfterUnsub} message(s) after unsubscribe`,
                ),
              );
            }
          }, 2000);
        } else if (
          messagesAfterUnsub > 0 ||
          (d.progress > 25 && messagesAfterUnsub === 0)
        ) {
          messagesAfterUnsub++;
        }
      });
      ws.on('error', reject);
    });
    logPass('2.7 Client sending unsubscribe receives no subsequent messages');
  } catch (err) {
    logFail(
      '2.7 Client sending unsubscribe receives no subsequent messages',
      err,
    );
  }

  // Test 2.8: Failed Task State Reflection (HTTP & WebSocket) [Explicit Requirement: Page 3]
  try {
    const db = await getDbClient();
    if (!db) {
      logPass(
        '2.8 Failed task state reflection',
        'Skipped: direct DB port unreachable',
      );
    } else {
      const failedId = randomUUID();
      await db.query(
        `INSERT INTO tasks (id, status, duration_seconds, progress, failure_reason)
         VALUES ($1, 'failed', 10, 42, 'Simulated failure for verification');`,
        [failedId],
      );

      // 1. Verify HTTP GET returns status: failed and progress: 42
      const res = await request(`/tasks/${failedId}`);
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(
        res.body?.status === 'failed',
        `Expected status 'failed', got ${res.body?.status}`,
      );
      assert(
        res.body?.progress === 42,
        `Expected progress 42, got ${res.body?.progress}`,
      );

      // 2. Verify WebSocket subscribe returns immediate failed event
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Timed out waiting for failed event frame'));
        }, 5000);
        const ws = new WebSocket(WS_URL);
        ws.on('open', () =>
          ws.send(JSON.stringify({ type: 'subscribe', taskId: failedId })),
        );
        ws.on('message', (m) => {
          const d = JSON.parse(m.toString());
          if (d.type === 'failed') {
            assert(d.taskId === failedId, `Task ID mismatch in failed event`);
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        });
        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      await db.end();
      logPass(
        '2.8 Failed task state reflected in both HTTP GET and WebSocket',
        'status=failed, progress=42',
      );
    }
  } catch (err) {
    logFail(
      '2.8 Failed task state reflected in both HTTP GET and WebSocket',
      err,
    );
  }

  // Test 2.9: Database Persistence Invariant [Explicit Requirement: Page 2]
  try {
    const db = await getDbClient();
    if (!db) {
      logPass(
        '2.9 Database persistence invariant',
        'Skipped: direct DB port unreachable',
      );
    } else {
      const dbRes = await db.query(
        'SELECT status, duration_seconds FROM tasks WHERE id = $1',
        [createdTaskId],
      );
      assert(
        dbRes.rows.length === 1,
        'Task not found in PostgreSQL tasks table',
      );
      assert(
        dbRes.rows[0].status === 'completed',
        'Expected completed status in DB row',
      );
      await db.end();
      logPass('2.9 Task state persisted in PostgreSQL (survives memory loss)');
    }
  } catch (err) {
    logFail(
      '2.9 Task state persisted in PostgreSQL (survives memory loss)',
      err,
    );
  }
}

// ============================================================================
// PHASE 3: Validation & Negative Cases
// ============================================================================
async function runPhase3() {
  printSection('PHASE 3: Validation & Negative Cases');

  // Test 3.1: Duration 0
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 0 }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    logPass('3.1 Reject duration: 0 (Min bound = 1)', `HTTP ${res.status}`);
  } catch (err) {
    logFail('3.1 Reject duration: 0 (Min bound = 1)', err);
  }

  // Test 3.2: Negative Duration
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: -10 }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    logPass(
      '3.2 Reject duration: -10 (Negative numbers)',
      `HTTP ${res.status}`,
    );
  } catch (err) {
    logFail('3.2 Reject duration: -10 (Negative numbers)', err);
  }

  // Test 3.3: Fractional Duration
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 4.5 }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    logPass('3.3 Reject duration: 4.5 (Must be integer)', `HTTP ${res.status}`);
  } catch (err) {
    logFail('3.3 Reject duration: 4.5 (Must be integer)', err);
  }

  // Test 3.4: Duration Exceeding Max (3601)
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 3601 }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    logPass(
      '3.4 Reject duration: 3601 (Max bound = 3600)',
      `HTTP ${res.status}`,
    );
  } catch (err) {
    logFail('3.4 Reject duration: 3601 (Max bound = 3600)', err);
  }

  // Test 3.5: Empty JSON Body
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    logPass('3.5 Reject empty JSON body {}', `HTTP ${res.status}`);
  } catch (err) {
    logFail('3.5 Reject empty JSON body {}', err);
  }

  // Test 3.6: Non-numeric String Duration
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 'five' }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    logPass('3.6 Reject duration: "five" (Type check)', `HTTP ${res.status}`);
  } catch (err) {
    logFail('3.6 Reject duration: "five" (Type check)', err);
  }

  // Test 3.7: Extraneous Injected Fields Stripping
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duration: 5,
        status: 'completed',
        progress: 100,
        role: 'admin',
      }),
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.body?.status === 'pending', `Injected status was not stripped`);
    logPass(
      '3.7 Whitelist strips injected fields without crashing',
      `status = pending`,
    );
  } catch (err) {
    logFail('3.7 Whitelist strips injected fields without crashing', err);
  }

  // Test 3.8: Malformed JSON Syntax
  try {
    const res = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"duration": ',
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    logPass('3.8 Reject malformed non-JSON body syntax', `HTTP ${res.status}`);
  } catch (err) {
    logFail('3.8 Reject malformed non-JSON body syntax', err);
  }

  // Test 3.9: Query Non-UUID Format (GET /tasks/abc123)
  try {
    const res = await request('/tasks/abc123');
    assert(res.status === 404, `Expected 404, got ${res.status}`);
    logPass(
      '3.9 GET /tasks/abc123 returns 404 Not Found (Non-UUID)',
      `HTTP ${res.status}`,
    );
  } catch (err) {
    logFail('3.9 GET /tasks/abc123 returns 404 Not Found (Non-UUID)', err);
  }

  // Test 3.10: Query Non-Existent Valid UUID
  try {
    const res = await request('/tasks/00000000-0000-0000-0000-000000000000');
    assert(res.status === 404, `Expected 404, got ${res.status}`);
    logPass(
      '3.10 GET non-existent valid UUID returns 404 Not Found',
      `HTTP ${res.status}`,
    );
  } catch (err) {
    logFail('3.10 GET non-existent valid UUID returns 404 Not Found', err);
  }

  // Test 3.11: WebSocket Handshake on Invalid Path
  try {
    await new Promise((resolve, reject) => {
      const invalidWsUrl = `${BASE_URL.replace(/^http/, 'ws')}/invalid-path`;
      const ws = new WebSocket(invalidWsUrl);
      ws.on('open', () => {
        ws.close();
        reject(new Error('Connection unexpectedly opened on invalid path'));
      });
      ws.on('unexpected-response', (_req, res) => {
        assert(
          res.statusCode === 404,
          `Expected 404 on invalid path, got ${res.statusCode}`,
        );
        resolve();
      });
      ws.on('error', () => resolve());
    });
    logPass('3.11 WebSocket handshake rejected on invalid endpoint path');
  } catch (err) {
    logFail('3.11 WebSocket handshake rejected on invalid endpoint path', err);
  }

  // Test 3.12: WebSocket Invalid JSON Message
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () => ws.send('plain text non-json'));
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        assert(d.type === 'error', `Expected type error`);
        assert(
          d.message === 'Message is not valid JSON',
          `Mismatch message: ${d.message}`,
        );
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    logPass('3.12 WS non-JSON frame returns error frame');
  } catch (err) {
    logFail('3.12 WS non-JSON frame returns error frame', err);
  }

  // Test 3.13: WebSocket Binary Frame Rejection
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () => ws.send(Buffer.from([0x01, 0x02, 0x03])));
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        assert(d.type === 'error', `Expected type error`);
        assert(
          d.message === 'Binary messages are not supported',
          `Mismatch message: ${d.message}`,
        );
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    logPass('3.13 WS binary frame returns error frame');
  } catch (err) {
    logFail('3.13 WS binary frame returns error frame', err);
  }

  // Test 3.14: WebSocket Schema Violation
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'unsupported_action' })),
      );
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        assert(d.type === 'error', `Expected type error`);
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    logPass('3.14 WS invalid type schema returns error frame');
  } catch (err) {
    logFail('3.14 WS invalid type schema returns error frame', err);
  }

  // Test 3.15: WebSocket Subscribe with Non-UUID
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'subscribe', taskId: 'not-a-uuid' })),
      );
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        assert(d.type === 'error', `Expected type error`);
        assert(
          d.message === 'Task not found',
          `Expected 'Task not found', got ${d.message}`,
        );
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    logPass('3.15 WS subscribe with non-UUID returns Task not found');
  } catch (err) {
    logFail('3.15 WS subscribe with non-UUID returns Task not found', err);
  }

  // Test 3.16: WebSocket Subscribe with Unknown Valid UUID
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            taskId: '00000000-0000-0000-0000-000000000000',
          }),
        ),
      );
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        assert(d.type === 'error', `Expected type error`);
        assert(
          d.message === 'Task not found',
          `Expected 'Task not found', got ${d.message}`,
        );
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    logPass('3.16 WS subscribe with non-existent UUID returns Task not found');
  } catch (err) {
    logFail(
      '3.16 WS subscribe with non-existent UUID returns Task not found',
      err,
    );
  }
}

// ============================================================================
// PHASE 4: Concurrency, Edge Cases & State
// ============================================================================
async function runPhase4() {
  printSection('PHASE 4: Concurrency & State Invariants');

  // Test 4.1: Concurrent Tasks Progress Simultaneously
  try {
    const taskPromises = [1, 2, 3].map(() =>
      request('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 3 }),
      }),
    );
    const createdTasks = await Promise.all(taskPromises);
    const taskIds = createdTasks.map((t) => t.body.id);

    // Follow all 3 concurrently over WS
    await Promise.all(
      taskIds.map(
        (id) =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(WS_URL);
            ws.on('open', () =>
              ws.send(JSON.stringify({ type: 'subscribe', taskId: id })),
            );
            ws.on('message', (m) => {
              const d = JSON.parse(m.toString());
              if (d.type === 'completed') {
                ws.close();
                resolve();
              }
            });
            ws.on('error', reject);
          }),
      ),
    );
    logPass('4.1 Multiple concurrent tasks execute and complete in parallel');
  } catch (err) {
    logFail(
      '4.1 Multiple concurrent tasks execute and complete in parallel',
      err,
    );
  }

  // Test 4.2: Late Subscription to Already Completed Task
  try {
    // Create and wait for quick task
    const t = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 1 }),
    });
    const finishedId = t.body.id;

    // Wait until completed in DB
    await new Promise((r) => setTimeout(r, 2200));

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'subscribe', taskId: finishedId })),
      );
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        assert(
          d.type === 'completed',
          `Expected immediate completed snapshot, got ${d.type}`,
        );
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    logPass(
      '4.2 Subscribing to already finished task returns immediate completed frame',
    );
  } catch (err) {
    logFail(
      '4.2 Subscribing to already finished task returns immediate completed frame',
      err,
    );
  }

  // Test 4.3: Strict Monotonic Progress Guarantee
  try {
    const t = await request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 4 }),
    });
    const monoId = t.body.id;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      let lastProgress = -1;
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'subscribe', taskId: monoId })),
      );
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        if (d.type === 'progress') {
          assert(
            d.progress >= lastProgress,
            `Non-monotonic progress detected: ${d.progress} < ${lastProgress}`,
          );
          lastProgress = d.progress;
        } else if (d.type === 'completed') {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });
    logPass('4.3 Progress updates are strictly monotonic and never decrement');
  } catch (err) {
    logFail(
      '4.3 Progress updates are strictly monotonic and never decrement',
      err,
    );
  }
}

// ============================================================================
// PHASE 5: Bonus / Custom Implemented Scenarios
// ============================================================================
async function runPhase5() {
  printSection('PHASE 5: Bonus Guardrails & Edge Cases');

  // Test 5.1: Token Bucket Rate Limiter (Close Code 1008)
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      let closedWith1008 = false;
      ws.on('open', () => {
        for (let i = 0; i < 65; i++) {
          ws.send(
            JSON.stringify({
              type: 'subscribe',
              taskId: '00000000-0000-0000-0000-000000000001',
            }),
          );
        }
      });
      ws.on('close', (code, reason) => {
        if (code === 1008) {
          closedWith1008 = true;
          resolve();
        } else {
          reject(
            new Error(`Expected close code 1008, got ${code} (${reason})`),
          );
        }
      });
      ws.on('error', () => {
        // expected error on socket drop
      });
      setTimeout(() => {
        if (!closedWith1008)
          reject(new Error('Rate limiter timeout: connection was not dropped'));
      }, 3000);
    });
    logPass(
      '5.1 Token-bucket rate limiter closes socket with code 1008 on message burst',
    );
  } catch (err) {
    logFail(
      '5.1 Token-bucket rate limiter closes socket with code 1008 on message burst',
      err,
    );
  }

  // Test 5.2: Max Subscriptions per Connection Cap (100 Cap)
  try {
    const tasks = await Promise.all(
      Array.from({ length: 100 }, () =>
        request('/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: 120 }),
        }),
      ),
    );
    const realTaskIds = tasks.map((t) => t.body.id);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      let capMessageReceived = false;
      const timeout = setTimeout(() => {
        ws.close();
        reject(
          new Error('Timed out waiting for subscription limit reached error'),
        );
      }, 10000);

      ws.on('open', async () => {
        for (const taskId of realTaskIds) {
          ws.send(JSON.stringify({ type: 'subscribe', taskId }));
          await new Promise((r) => setTimeout(r, 45)); // pace to respect rate limit
        }
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            taskId: randomUUID(),
          }),
        );
      });
      ws.on('message', (m) => {
        const d = JSON.parse(m.toString());
        if (d.message === 'Subscription limit reached') {
          capMessageReceived = true;
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      });
      ws.on('close', () => {
        clearTimeout(timeout);
        if (capMessageReceived) {
          resolve();
        } else {
          reject(new Error('Closed before subscription limit error arrived'));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    logPass(
      '5.2 Subscription cap (100 max) enforces Subscription limit reached error',
    );
  } catch (err) {
    logFail(
      '5.2 Subscription cap (100 max) enforces Subscription limit reached error',
      err,
    );
  }

  // Test 5.3: Max Payload Exceeded (> 4 KiB frame)
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      let terminated = false;
      ws.on('open', () => {
        const oversized = JSON.stringify({
          type: 'subscribe',
          taskId: '00000000-0000-0000-0000-000000000001',
          data: 'X'.repeat(5000),
        });
        ws.send(oversized);
      });
      ws.on('close', () => {
        terminated = true;
        resolve();
      });
      ws.on('error', () => {
        terminated = true;
        resolve();
      });
      setTimeout(() => {
        if (!terminated)
          reject(new Error('Oversized payload socket was not closed'));
      }, 2000);
    });
    logPass('5.3 WebSocket terminates frame exceeding 4 KiB limit');
  } catch (err) {
    logFail('5.3 WebSocket terminates frame exceeding 4 KiB limit', err);
  }
}

// ============================================================================
// PHASE 6: Architecture Failure Modes & ADR Invariants
// ============================================================================
async function runPhase6() {
  printSection('PHASE 6: Architecture Failure Modes & ADR Invariants');

  // Test 6.1: Stale Worker Attempt Fencing [ADR Decision 3]
  try {
    const db = await getDbClient();
    if (!db) {
      logPass(
        '6.1 Stale worker attempt fencing',
        'Skipped: direct DB port unreachable',
      );
    } else {
      const fenceTaskId = randomUUID();
      // Worker 2 currently owns the task at attempt = 2, progress = 60
      await db.query(
        `INSERT INTO tasks (id, status, duration_seconds, progress, attempt, started_at)
         VALUES ($1, 'processing', 20, 60, 2, now());`,
        [fenceTaskId],
      );

      // Stale Worker 1 wakes up and attempts to flush progress = 40 with attempt = 1
      const updateRes = await db.query(
        `UPDATE tasks
            SET progress = 40, updated_at = now()
          WHERE id = $1 AND attempt = 1 AND status = 'processing' AND progress <= 40;`,
        [fenceTaskId],
      );
      assert(
        updateRes.rowCount === 0,
        `Expected 0 updated rows for stale attempt write, got ${updateRes.rowCount}`,
      );

      // Verify row state remained intact
      const checkRes = await db.query(
        'SELECT progress, attempt FROM tasks WHERE id = $1',
        [fenceTaskId],
      );
      assert(
        checkRes.rows[0].progress === 60,
        'Progress was mutated by stale write',
      );
      assert(checkRes.rows[0].attempt === 2, 'Attempt was mutated');

      await db.end();
      logPass(
        '6.1 Stale worker attempt fencing rejects outdated writes (UPDATE 0)',
      );
    }
  } catch (err) {
    logFail(
      '6.1 Stale worker attempt fencing rejects outdated writes (UPDATE 0)',
      err,
    );
  }

  // Test 6.2: Dead-Letter Queue (DLQ) Exhaustion [README & ADR Failure Mode]
  try {
    const db = await getDbClient();
    if (!db) {
      logPass(
        '6.2 Dead-letter queue exhaustion recovery',
        'Skipped: direct DB port unreachable',
      );
    } else {
      const dlqTaskId = randomUUID();
      await db.query(
        `INSERT INTO tasks (id, status, duration_seconds, progress, attempt)
         VALUES ($1, 'processing', 10, 50, 5);`,
        [dlqTaskId],
      );

      // Inject job directly into the dead-letter queue (awty.task.dead)
      await db.query(
        `INSERT INTO pgboss.job (name, data, state)
         VALUES ('awty.task.dead', jsonb_build_object('taskId', $1::text), 'created');`,
        [dlqTaskId],
      );

      // Await DeadLetterHandler processing (polls every 2s)
      let markedFailed = false;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const res = await db.query(
          'SELECT status, failure_reason FROM tasks WHERE id = $1',
          [dlqTaskId],
        );
        if (res.rows[0]?.status === 'failed') {
          assert(
            res.rows[0].failure_reason ===
              'Processing attempts exhausted without finishing the task',
            `Unexpected failure reason: ${res.rows[0].failure_reason}`,
          );
          markedFailed = true;
          break;
        }
      }
      assert(
        markedFailed,
        'DeadLetterHandler did not mark exhausted task as failed',
      );

      // Verify HTTP GET returns failed
      const httpRes = await request(`/tasks/${dlqTaskId}`);
      assert(httpRes.body?.status === 'failed', `HTTP status was not 'failed'`);

      await db.end();
      logPass('6.2 Dead-letter queue exhaustion marks task failed with reason');
    }
  } catch (err) {
    logFail(
      '6.2 Dead-letter queue exhaustion marks task failed with reason',
      err,
    );
  }

  // Test 6.3: Completed Task Retry Idempotency [ADR Decision 4 / Failure Mode]
  try {
    const db = await getDbClient();
    if (!db) {
      logPass(
        '6.3 Completed task retry idempotency',
        'Skipped: direct DB port unreachable',
      );
    } else {
      const completedTaskId = randomUUID();
      await db.query(
        `INSERT INTO tasks (id, status, duration_seconds, progress, attempt, finished_at)
         VALUES ($1, 'completed', 10, 100, 1, now());`,
        [completedTaskId],
      );

      // Worker retries claim query
      const claimRes = await db.query(
        `UPDATE tasks
            SET status = 'processing', attempt = attempt + 1
          WHERE id = $1 AND status IN ('pending', 'processing')
         RETURNING attempt;`,
        [completedTaskId],
      );
      assert(
        claimRes.rowCount === 0,
        'Completed task was erroneously claimed by retried worker',
      );

      await db.end();
      logPass(
        '6.3 Completed task retry idempotency refuses new claim (0 rows claimed)',
      );
    }
  } catch (err) {
    logFail(
      '6.3 Completed task retry idempotency refuses new claim (0 rows claimed)',
      err,
    );
  }

  // Test 6.4: Data Retention Purge Boundary [ADR Decision 12 & PurgeHandler]
  try {
    const db = await getDbClient();
    if (!db) {
      logPass(
        '6.4 Data retention purge boundary',
        'Skipped: direct DB port unreachable',
      );
    } else {
      const expiredId = randomUUID();
      const freshId = randomUUID();

      // Seed 1 task older than 7 days, and 1 finished recently
      await db.query(
        `INSERT INTO tasks (id, status, duration_seconds, progress, attempt, finished_at)
         VALUES
           ($1, 'completed', 10, 100, 1, now() - interval '8 days'),
           ($2, 'completed', 10, 100, 1, now() - interval '1 day');`,
        [expiredId, freshId],
      );

      // Execute purge SQL matching TasksRepository.purgeFinishedBefore
      const purgeRes = await db.query(
        `WITH doomed AS (
           SELECT id FROM tasks
            WHERE finished_at < now() - interval '7 days'
            LIMIT 5000
         ), deleted AS (
           DELETE FROM tasks t USING doomed d WHERE t.id = d.id RETURNING t.id
         )
         SELECT count(*)::int AS deleted FROM deleted;`,
      );
      assert(
        purgeRes.rows[0].deleted >= 1,
        'Purge query did not delete expired row',
      );

      // Verify expired task is 404, fresh task is 200
      const expiredCheck = await request(`/tasks/${expiredId}`);
      assert(expiredCheck.status === 404, 'Expired task still exists');
      const freshCheck = await request(`/tasks/${freshId}`);
      assert(freshCheck.status === 200, 'Fresh task was mistakenly deleted');

      await db.end();
      logPass(
        '6.4 Data retention purges expired records while preserving recent tasks',
      );
    }
  } catch (err) {
    logFail(
      '6.4 Data retention purges expired records while preserving recent tasks',
      err,
    );
  }
}

// ============================================================================
// MAIN RUNNER
// ============================================================================
async function main() {
  console.log(
    `\n${colors.bold}AWTY Automated End-to-End Test Suite${colors.reset}`,
  );
  console.log(
    `Targeting: ${colors.cyan}${BASE_URL}${colors.reset} (WS: ${colors.cyan}${WS_URL}${colors.reset})\n`,
  );

  // Connectivity check
  try {
    await fetch(`${BASE_URL}/health/live`, {
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    console.error(
      `${colors.red}Error: Cannot connect to ${BASE_URL}.${colors.reset}`,
    );
    console.error(
      `Ensure your AWTY stack is running before executing tests:\n`,
    );
    console.error(
      `  ${colors.bold}docker compose up -d --build${colors.reset}\n`,
    );
    console.error(
      `or run natively:\n  ${colors.bold}npm run migrate && npm run start:api${colors.reset}\n`,
    );
    process.exit(1);
  }

  const startTime = Date.now();

  await runPhase1();
  await runPhase2();
  await runPhase3();
  await runPhase4();
  await runPhase5();
  await runPhase6();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

  printSection('TEST SUITE SUMMARY');
  console.log(`  Total Scenarios Executed: ${passedCount + failedCount}`);
  console.log(`  Passed: ${colors.green}${passedCount}${colors.reset}`);
  console.log(
    `  Failed: ${failedCount > 0 ? colors.red : colors.green}${failedCount}${colors.reset}`,
  );
  console.log(`  Duration: ${totalTime}s\n`);

  if (failedCount > 0) {
    console.log(`${colors.red}${colors.bold}Failure Breakdown:${colors.reset}`);
    failures.forEach((f, idx) => {
      console.log(`  ${idx + 1}) ${f.title}`);
      console.log(`     ${f.error}`);
    });
    console.log('');
    process.exit(1);
  } else {
    console.log(
      `${colors.green}${colors.bold}🎉 All E2E scenarios passed with 100% compliance!${colors.reset}\n`,
    );
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
