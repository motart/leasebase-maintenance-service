import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import { maintenanceRouter } from './routes/maintenance';

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
});

app.use('/internal/maintenance', maintenanceRouter);

startApp(app);
