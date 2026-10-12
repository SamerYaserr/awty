import WebSocket from 'ws';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const baseUrl =
  option('url') ?? process.env.AWTY_URL ?? 'http://localhost:3000';
const watchId = option('watch');
const duration = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 10);
const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;

const say = (text) =>
  console.log(`${new Date().toISOString().slice(11, 23)}  ${text}`);
const FINAL_TYPES = new Set(['completed', 'failed', 'error']);

async function createTask() {
  const response = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ duration }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `POST /tasks failed with ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  say(`POST /tasks -> ${response.status} ${JSON.stringify(body)}`);
  return body.id;
}

function follow(taskId) {
  return new Promise((resolve) => {
    let failures = 0;
    let finalMessage;

    const connect = () => {
      const socket = new WebSocket(wsUrl);

      socket.on('open', () => {
        failures = 0;
        say('connected, subscribing');
        socket.send(JSON.stringify({ type: 'subscribe', taskId }));
      });

      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        say(JSON.stringify(message));
        if (FINAL_TYPES.has(message.type)) {
          finalMessage = message;
          socket.close();
        }
      });

      socket.on('close', (code) => {
        if (finalMessage) {
          resolve(finalMessage);
          return;
        }
        const delay = Math.round(
          Math.min(10_000, 500 * 2 ** failures) * (0.5 + Math.random() / 2),
        );
        failures += 1;
        say(`connection closed (${code}), reconnecting in ${delay} ms`);
        setTimeout(connect, delay);
      });

      socket.on('error', () => undefined);
    };

    connect();
  });
}

const taskId = watchId ?? (await createTask());
if (watchId) {
  say(`following task ${watchId}`);
}
const last = await follow(taskId);

const state = await (await fetch(`${baseUrl}/tasks/${taskId}`)).json();
say(`GET /tasks/${taskId} -> ${JSON.stringify(state)}`);
process.exit(last.type === 'completed' ? 0 : 1);
