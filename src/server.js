import { config } from './config.js';
import app from './app.js';

app.listen(config.port, () => {
  console.log(`Payment backend listening on port ${config.port}`);
});
