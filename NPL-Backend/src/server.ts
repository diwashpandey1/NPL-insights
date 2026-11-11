import { app } from './app.js';
import { env } from './config/env.js';

app.listen(env.PORT, () => {
  console.info(`NPL API listening on port ${env.PORT} (${env.NODE_ENV})`);
});
