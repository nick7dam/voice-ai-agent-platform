import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import WebSocket, { RawData } from 'ws';

interface CliOptions {
  url: string;
  taskKey: string;
  file?: string;
  mimeType: string;
  text?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    url: 'ws://localhost:3000/realtime',
    taskKey: 'general_voice_assistant',
    mimeType: 'audio/wav',
    text: 'Remember that my favorite demo color is green.',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === '--url' && next) {
      options.url = next;
      index += 1;
    } else if (arg === '--task' && next) {
      options.taskKey = next;
      index += 1;
    } else if (arg === '--file' && next) {
      options.file = next;
      options.text = undefined;
      index += 1;
    } else if (arg === '--mime' && next) {
      options.mimeType = next;
      index += 1;
    } else if (arg === '--text' && next) {
      options.text = next;
      options.file = undefined;
      index += 1;
    }
  }

  return options;
}

function send(socket: WebSocket, event: Record<string, unknown>): void {
  socket.send(JSON.stringify(event));
}

function rawDataToString(raw: RawData): string {
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }

  return Buffer.from(raw).toString('utf8');
}

function main(): void {
  const options = parseArgs();
  const socket = new WebSocket(options.url);
  let sessionId: string | undefined;

  socket.on('open', () => {
    send(socket, {
      type: 'session.start',
      payload: {
        taskKey: options.taskKey,
        metadata: {
          client: 'local-cli',
        },
      },
    });
  });

  socket.on('message', (raw) => {
    void handleServerEvent(raw);
  });

  async function handleServerEvent(raw: RawData): Promise<void> {
    const event = JSON.parse(rawDataToString(raw)) as {
      type: string;
      payload?: Record<string, unknown>;
    };

    console.log(JSON.stringify(event, null, 2));

    if (event.type === 'session.started') {
      sessionId = String(event.payload?.sessionId);

      if (options.file) {
        const audio = await readFile(options.file);
        console.log(
          `Sending ${basename(options.file)} (${audio.byteLength} bytes, ${options.mimeType})`,
        );
        send(socket, {
          type: 'audio.chunk',
          sessionId,
          payload: {
            audioBase64: audio.toString('base64'),
            mimeType: options.mimeType,
            isFinal: true,
          },
        });
      } else {
        send(socket, {
          type: 'text.message',
          sessionId,
          payload: {
            text: options.text,
          },
        });
      }
    }

    if (event.type === 'assistant.response' || event.type === 'error') {
      if (sessionId) {
        send(socket, {
          type: 'session.end',
          sessionId,
          payload: {},
        });
      } else {
        socket.close();
      }
    }

    if (event.type === 'session.ended') {
      socket.close();
    }
  }

  socket.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

main();
