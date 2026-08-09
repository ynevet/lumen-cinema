import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../middleware/auth.js';
import {
  cancelHold,
  confirmHold,
  getMyReservation,
  listMyReservations,
} from '../services/reservationService.js';

const reservationIdParam = z.object({
  reservationId: z.string().uuid('Not a valid reservation id.'),
});

export const reservationRoutes = Router();

reservationRoutes.use(requireAuth);

reservationRoutes.get('/', async (req, res) => {
  const user = currentUser(req);
  const activeOnly = req.query.active === 'true';
  res.json({ reservations: await listMyReservations(user.id, { activeOnly }) });
});

reservationRoutes.get('/:reservationId', async (req, res) => {
  const { reservationId } = reservationIdParam.parse(req.params);
  const user = currentUser(req);
  res.json({ reservation: await getMyReservation(reservationId, user.id) });
});

/** Complete the purchase: hold -> booked. */
reservationRoutes.post('/:reservationId/confirm', async (req, res) => {
  const { reservationId } = reservationIdParam.parse(req.params);
  const user = currentUser(req);
  res.json({ reservation: await confirmHold(reservationId, user.id) });
});

/** Give the seats back early instead of waiting for the hold to lapse. */
reservationRoutes.delete('/:reservationId', async (req, res) => {
  const { reservationId } = reservationIdParam.parse(req.params);
  const user = currentUser(req);
  res.json({ reservation: await cancelHold(reservationId, user.id) });
});
