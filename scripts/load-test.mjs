import WebSocket from 'ws';

const args = process.argv.slice(2);
const number = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};

const baseUrl = process.env.AWTY_URL ?? 'http://localhost:3000';
const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;
const total = number('tasks', 1000);
const duration = number('duration', 10);
const concurrency = number('concurrency', 40);
const clientCount = number('clients', 100);
const perClient = number('follow', 10);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
};
const ms = (value) => `${Math.round(value)} ms`;

const ids = [];
const postLatencies = [];
let next = 0;
const startedAt = Date.now();

async function creator() {
  for (;;) {
    if (next++ >= total) return;
    const began = performance.now();
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ duration }),
    });
    if (response.status !== 201) {
      throw new Error(`POST /tasks answered ${response.status}`);
    }
    postLatencies.push(performance.now() - began);
    ids.push((await response.json()).id);
  }
}

const followed = [];
let messages = 0;
const sockets = [];
function startClients() {
  for (let client = 0; client < clientCount; client += 1) {
    const socket = new WebSocket(wsUrl);
    const mine = new Set();
    socket.on('open', () => {
      for (let n = 0; n < perClient && ids.length > 0; n += 1) {
        const taskId = ids[Math.floor(Math.random() * ids.length)];
        mine.add(taskId);
        socket.send(JSON.stringify({ type: 'subscribe', taskId }));
      }
    });
    socket.on('message', (raw) => {
      messages += 1;
      const message = JSON.parse(raw.toString());
      if (message.type === 'completed') mine.delete(message.taskId);
    });
    sockets.push(socket);
    followed.push(mine);
  }
}

setTimeout(startClients, 1500);
await Promise.all(Array.from({ length: concurrency }, creator));
const createMs = Date.now() - startedAt;
console.log(
  `created ${total} tasks in ${ms(createMs)} (${Math.round((total / createMs) * 1000)}/s), ` +
    `POST latency p50/p95/p99 = ${ms(percentile(postLatencies, 50))} / ${ms(percentile(postLatencies, 95))} / ${ms(percentile(postLatencies, 99))}`,
);

const pending = new Set(ids);
let failed = 0;
while (pending.size > 0) {
  const batch = [...pending].slice(0, 200);
  await Promise.all(
    batch.map(async (id) => {
      const state = await (await fetch(`${baseUrl}/tasks/${id}`)).json();
      if (state.status === 'completed') pending.delete(id);
      if (state.status === 'failed') {
        pending.delete(id);
        failed += 1;
      }
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const totalMs = Date.now() - startedAt;
await new Promise((resolve) => setTimeout(resolve, 1500));

const missed = followed.reduce((sum, set) => sum + set.size, 0);
console.log(
  `all ${total} tasks finished ${ms(totalMs)} after the first request (${failed} failed); one task takes ${duration * 1000} ms`,
);
console.log(
  `websocket: ${clientCount} clients received ${messages} messages, ${missed} followed tasks without a final message`,
);
sockets.forEach((socket) => socket.close());
process.exit(failed === 0 && missed === 0 ? 0 : 1);
