import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Integration tests run against the dedicated test database and Redis DB (see .env.test).
// In CI the same variables are provided by the job environment instead of a file.
const file = resolve(__dirname, '../.env.test');
if (existsSync(file)) process.loadEnvFile(file);
process.env.NODE_ENV = 'test';
// Never send email from tests (the development .env may point at Mailpit).
process.env.SMTP_URL ??= '';
