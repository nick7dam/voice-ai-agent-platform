import { loadDotenv } from '../src/config/dotenv';
import { envSchema } from '../src/config/env.schema';
import { describeNetworkError } from '../src/common/utils/network-error';
import { requestText } from '../src/common/utils/http-client';

async function main(): Promise<void> {
  loadDotenv();
  const env = envSchema.parse(process.env);
  const baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, '');
  const tagsUrl = `${baseUrl}/api/tags`;

  console.log(`OLLAMA_BASE_URL=${baseUrl}`);
  console.log(`OLLAMA_MODEL=${env.OLLAMA_MODEL}`);
  console.log(`OLLAMA_REQUEST_TIMEOUT_MS=${env.OLLAMA_REQUEST_TIMEOUT_MS}`);
  console.log(`OLLAMA_HEALTH_TIMEOUT_MS=${env.OLLAMA_HEALTH_TIMEOUT_MS}`);

  try {
    const response = await requestText(tagsUrl, {
      timeoutMs: env.OLLAMA_HEALTH_TIMEOUT_MS,
    });
    console.log(`node:http status=${response.status}`);
    console.log(response.body);
  } catch (error) {
    console.error('node:http failed');
    console.error(JSON.stringify(describeNetworkError(error), null, 2));
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetch(tagsUrl);
    console.log(`fetch status=${response.status}`);
    console.log(await response.text());
  } catch (error) {
    console.error('fetch failed');
    console.error(JSON.stringify(describeNetworkError(error), null, 2));
    process.exitCode = 1;
  }
}

void main();
