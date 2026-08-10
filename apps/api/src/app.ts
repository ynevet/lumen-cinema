import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/pool.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter, authLimiter } from './middleware/rateLimit.js';
import { authRoutes } from './routes/authRoutes.js';
import { screeningRoutes } from './routes/screeningRoutes.js';
import { reservationRoutes } from './routes/reservationRoutes.js';

export function createApp(): express.Express {
  const app = express();

  // Behind nginx in the Docker setup; trust one hop so client IPs are accurate.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins === '*' ? true : config.corsOrigins,
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '64kb' }));
  app.use(
    pinoHttp({
      logger,
      // Health checks would otherwise drown out real traffic.
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  app.get('/api/config', (_req, res) => {
    // Lets the client show the right countdown and seat cap without hard-coding them.
    res.json({
      holdMinutes: config.HOLD_MINUTES,
      maxSeatsPerReservation: config.MAX_SEATS_PER_RESERVATION,
    });
  });

  // Health and config sit above the limiter: container probes must never be throttled.
  app.use('/api', apiLimiter);
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/screenings', screeningRoutes);
  app.use('/api/reservations', reservationRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
