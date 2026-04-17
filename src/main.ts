import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { APP_CONFIG } from './common/constants/injection-tokens';
import { AppModule } from './app.module';
import { AppConfig } from './config/app.config';
import { loadDotenv } from './config/dotenv';

async function bootstrap() {
  loadDotenv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);

  app.enableCors();
  app.useStaticAssets(join(process.cwd(), 'public'));

  await app.listen(config.port);
  const url = await app.getUrl();
  console.log(`Voice agent MVP listening on ${url}`);
  console.log(`Realtime websocket path: ${config.wsPath}`);
}
void bootstrap();
