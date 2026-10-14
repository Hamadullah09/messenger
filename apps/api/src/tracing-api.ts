import { startErrorReporting } from './infra/error-reporting';
import { startTracing } from './tracing';

startTracing('sma-api');
startErrorReporting('sma-api');
