import './load-env';
import './tracing-worker';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // SIGTERM/SIGINT close the relay loop and wait for in-flight delivery jobs.
  app.enableShutdownHooks();
  await app.init();
  app.get(Logger).log('Worker started');
}

main().catch((error: unknown) => {
  console.error('Worker failed to start', error);
  process.exit(1);
});
