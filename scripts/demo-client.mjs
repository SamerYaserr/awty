#!/usr/bin/env node

import WebSocket from 'ws';

const args = process.argv.slice(2);
const hasFlag = (name) =>
  args.includes(`--${name}`) || args.includes(`-${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

if (hasFlag('help') || hasFlag('h')) {
  console.log(`
AWTY (Are We There Yet?) - Real-time Task Demo Client

Usage:
  npm run demo -- [duration] [options]

Arguments:
  duration          Task duration in seconds (1 to 3600, default: 10)

Options:
  --watch <taskId>  Follow an existing task without creating a new one
  --url <url>       API base URL (default: http://localhost:3000, or $AWTY_URL)
  --raw             Output raw JSON protocol messages instead of formatted UI
  --no-color        Disable ANSI color output
  --help, -h        Show this help message

Examples:
  npm run demo -- 10
  npm run demo -- --watch 8f24b3c1-0c4a-4e2a-89a1-fb2402179b2a
  npm run demo -- 20 --raw
`);
  process.exit(0);
}

const isColorSupported =
  !hasFlag('no-color') &&
  process.env.NO_COLOR === undefined &&
  (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR !== undefined);

const colors = isColorSupported
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      cyan: '\x1b[36m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      red: '\x1b[31m',
      blue: '\x1b[34m',
    }
  : {
      reset: '',
      bold: '',
      dim: '',
      cyan: '',
      green: '',
      yellow: '',
      red: '',
      blue: '',
    };

const isRaw = hasFlag('raw');
const baseUrl =
  option('url') ?? process.env.AWTY_URL ?? 'http://localhost:3000';
const watchId = option('watch');
const rawDurationArg = args.find((arg) => /^-?\d+$/.test(arg));
const duration = rawDurationArg !== undefined ? Number(rawDurationArg) : 10;
const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;

const timestamp = () =>
  `${colors.dim}${new Date().toISOString().slice(11, 23)}${colors.reset}`;
const log = (msg) => console.log(`${timestamp()}  ${msg}`);

const FINAL_TYPES = new Set(['completed', 'failed', 'error']);
let currentTaskId = null;

process.on('SIGINT', () => {
  console.log(`\n\n${colors.yellow}Demo interrupted by user.${colors.reset}`);
  if (currentTaskId) {
    console.log(
      `Task is continuing in the background. Resume watching anytime with:\n  ${colors.cyan}npm run demo -- --watch ${currentTaskId}${colors.reset}\n`,
    );
  }
  process.exit(130);
});

function renderProgressBar(progress, width = 30) {
  const p = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  const bar = `${colors.green}${'█'.repeat(filled)}${colors.dim}${'░'.repeat(empty)}${colors.reset}`;
  return `[${bar}] ${colors.bold}${String(p).padStart(3)}%${colors.reset}`;
}

async function createTask() {
  let response;
  try {
    response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ duration }),
    });
  } catch (err) {
    if (
      err.cause?.code === 'ECONNREFUSED' ||
      err.message?.includes('fetch failed')
    ) {
      console.error(
        `\n${colors.red}${colors.bold}✖ Connection refused:${colors.reset} Could not reach AWTY API at ${baseUrl}`,
      );
      console.error(
        `${colors.yellow}  Please ensure the service is running:${colors.reset}`,
      );
      console.error(`    docker compose up -d   (or npm run start:api)\n`);
      process.exit(1);
    }
    throw err;
  }

  const body = await response.json();
  if (!response.ok) {
    if (isRaw) {
      console.error(
        `POST /tasks failed with ${response.status}: ${JSON.stringify(body)}`,
      );
    } else {
      console.error(
        `\n${colors.red}${colors.bold}✖ Failed to create task (${response.status}):${colors.reset}`,
      );
      const messages = Array.isArray(body.message)
        ? body.message
        : [body.message ?? 'Unknown error'];
      messages.forEach((m) => console.error(`  - ${m}`));
      console.error('');
    }
    process.exit(1);
  }

  if (isRaw) {
    log(`POST /tasks -> ${response.status} ${JSON.stringify(body)}`);
  } else {
    log(
      `${colors.green}✔ POST /tasks${colors.reset} (${response.status} Created) -> Task ID: ${colors.cyan}${colors.bold}${body.id}${colors.reset} (Duration: ${duration}s)`,
    );
  }
  return body.id;
}

function follow(taskId) {
  return new Promise((resolve) => {
    let failures = 0;
    let finalMessage;
    const startTime = performance.now();

    const connect = () => {
      const socket = new WebSocket(wsUrl);

      socket.on('open', () => {
        if (failures > 0) {
          log(
            `${colors.green}⚡ Reconnected to WebSocket! Resuming subscription...${colors.reset}`,
          );
        } else if (isRaw) {
          log('connected, subscribing');
        } else {
          log(
            `${colors.blue}⚡ Connected to ${wsUrl}${colors.reset}, subscribing to task ${colors.cyan}${taskId}${colors.reset}...`,
          );
        }
        failures = 0;
        socket.send(JSON.stringify({ type: 'subscribe', taskId }));
      });

      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (isRaw) {
          log(JSON.stringify(message));
        } else {
          const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(
            1,
          );
          if (message.type === 'progress') {
            const bar = renderProgressBar(message.progress);
            log(
              `${bar}  ${colors.dim}(elapsed: ${elapsedSec}s)${colors.reset}`,
            );
          } else if (message.type === 'pending') {
            const bar = renderProgressBar(message.progress);
            const statusLabel =
              message.progress > 0
                ? `${colors.yellow}⏳ WORKER LOST - RETRYING FROM ${message.progress}% (QUEUED)${colors.reset}`
                : `${colors.dim}⏳ QUEUED (WAITING FOR WORKER)${colors.reset}`;
            log(
              `${bar}  ${statusLabel} ${colors.dim}(elapsed: ${elapsedSec}s)${colors.reset}`,
            );
          } else if (message.type === 'completed') {
            const bar = renderProgressBar(100);
            log(
              `${bar}  ${colors.green}${colors.bold}✔ COMPLETED${colors.reset} ${colors.dim}(total: ${elapsedSec}s)${colors.reset}`,
            );
          } else if (message.type === 'failed') {
            log(
              `${colors.red}${colors.bold}✖ TASK FAILED${colors.reset} ${colors.dim}(elapsed: ${elapsedSec}s)${colors.reset}`,
            );
          } else if (message.type === 'error') {
            log(
              `${colors.red}✖ WebSocket error:${colors.reset} ${message.message ?? JSON.stringify(message)}`,
            );
          } else {
            log(`${JSON.stringify(message)}`);
          }
        }

        if (FINAL_TYPES.has(message.type)) {
          finalMessage = message;
          socket.close();
        }
      });

      socket.on('close', (code) => {
        if (finalMessage) {
          resolve({ finalMessage, startTime });
          return;
        }
        const delay = Math.round(
          Math.min(10_000, 500 * 2 ** failures) * (0.5 + Math.random() / 2),
        );
        failures += 1;
        if (isRaw) {
          log(`connection closed (${code}), reconnecting in ${delay} ms`);
        } else {
          log(
            `${colors.yellow}⚠️  Connection closed (${code}), reconnecting in ${delay} ms (attempt ${failures})...${colors.reset}`,
          );
        }
        setTimeout(connect, delay);
      });

      socket.on('error', (err) => {
        if (isRaw) {
          log(`socket error: ${err.message}`);
        }
      });
    };

    connect();
  });
}

const taskId = watchId ?? (await createTask());
currentTaskId = taskId;

if (watchId) {
  if (isRaw) {
    log(`following task ${watchId}`);
  } else {
    log(
      `${colors.blue}👁  Watching existing task:${colors.reset} ${colors.cyan}${colors.bold}${watchId}${colors.reset}`,
    );
  }
}

const result = await follow(taskId);

let state = null;
let getStatus = null;
try {
  const getRes = await fetch(`${baseUrl}/tasks/${taskId}`);
  getStatus = getRes.status;
  if (getRes.ok) {
    state = await getRes.json();
  }
} catch {
  state = null;
}

if (isRaw) {
  log(`GET /tasks/${taskId} -> ${JSON.stringify(state)}`);
} else if (result.finalMessage.type === 'error') {
  console.log(`\n${colors.dim}${'─'.repeat(64)}${colors.reset}`);
  console.log(
    `${colors.red}${colors.bold}✖ Task Error Encountered${colors.reset}`,
  );
  console.log(`  Task ID:      ${colors.cyan}${taskId}${colors.reset}`);
  console.log(
    `  Error Detail: ${result.finalMessage.message ?? 'Unknown error'}`,
  );
  if (getStatus) {
    console.log(
      `  HTTP Lookup:  ${getStatus === 404 ? colors.yellow : colors.red}HTTP ${getStatus}${colors.reset}`,
    );
  }
  console.log(`${colors.dim}${'─'.repeat(64)}${colors.reset}\n`);
} else if (state) {
  const totalElapsed = ((performance.now() - result.startTime) / 1000).toFixed(
    2,
  );
  console.log(`\n${colors.dim}${'─'.repeat(64)}${colors.reset}`);
  if (result.finalMessage.type === 'completed') {
    console.log(
      `${colors.green}${colors.bold}🎉 Task Finished Successfully!${colors.reset}`,
    );
  } else if (result.finalMessage.type === 'failed') {
    console.log(
      `${colors.red}${colors.bold}✖ Task Finished with Status: FAILED${colors.reset}`,
    );
  } else {
    console.log(
      `${colors.yellow}${colors.bold}ℹ Follow Ended (${result.finalMessage.type})${colors.reset}`,
    );
  }
  console.log(`  Task ID:      ${colors.cyan}${taskId}${colors.reset}`);
  console.log(
    `  Status:       ${state.status === 'completed' ? colors.green : colors.yellow}${state.status}${colors.reset}`,
  );
  console.log(`  Progress:     ${state.progress ?? 0}%`);
  console.log(
    `  Duration:     ${state.durationSeconds ?? duration}s (client observed: ${totalElapsed}s)`,
  );
  console.log(
    `  Verified via: ${colors.dim}GET /tasks/${taskId} (200 OK)${colors.reset}`,
  );
  console.log(`${colors.dim}${'─'.repeat(64)}${colors.reset}\n`);
}

process.exit(result.finalMessage.type === 'completed' ? 0 : 1);
