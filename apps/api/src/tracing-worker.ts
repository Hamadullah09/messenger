import { startErrorReporting } from './infra/error-reporting';
import { startTracing } from './tracing';

startTracing('sma-worker');
startErrorReporting('sma-worker');
