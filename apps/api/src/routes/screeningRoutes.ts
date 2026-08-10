import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { getSeatMap, listScreenings } from '../services/screeningService.js';
import { createHold, listMyReservations } from '../services/reservationService.js';

const screeningIdParam = z.object({
  screeningId: z.coerce.number().int().positive(),
});

const holdSchema = z.object({
  seatIds: z
    .array(z.number().int().positive())
    .min(1, 'Select at least one seat.')
    .max(20, 'Too many seats in one request.'),
});

export const screeningRoutes = Router();

// Everything below needs a signed-in user.
screeningRoutes.use(requireAuth);

screeningRoutes.get('/', async (_req, res) => {
  res.json({ screenings: await listScreenings() });
});

screeningRoutes.get('/:screeningId/seatmap', async (req, res) => {
  const { screeningId } = screeningIdParam.parse(req.params);
  const user = currentUser(req);
  res.json(await getSeatMap(screeningId, user.id));
});

// `?active=true` narrows to live holds and bookings; the default is the full history.
screeningRoutes.get('/:screeningId/reservations', async (req, res) => {
  const { screeningId } = screeningIdParam.parse(req.params);
  const user = currentUser(req);
  const activeOnly = req.query.active === 'true';
  res.json({ reservations: await listMyReservations(user.id, { screeningId, activeOnly }) });
});

/** Place a hold. 409 = someone beat you to a seat, 422 = the selection breaks a rule. */
screeningRoutes.post('/:screeningId/reservations', async (req, res) => {
  const { screeningId } = screeningIdParam.parse(req.params);
  const { seatIds } = holdSchema.parse(req.body);
  const user = currentUser(req);

  const reservation = await createHold({ userId: user.id, screeningId, seatIds });
  res.status(201).json({ reservation });
});
