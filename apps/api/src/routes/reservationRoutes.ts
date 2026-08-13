import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../middleware/auth.js';
import {
  addSeatToHold,
  cancelHold,
  confirmHold,
  getMyReservation,
  listMyReservations,
  removeSeatFromHold,
} from '../services/reservationService.js';

const reservationIdParam = z.object({
  reservationId: z.string().uuid('Not a valid reservation id.'),
});

const seatParams = reservationIdParam.extend({
  seatId: z.coerce.number().int().positive(),
});

const seatBody = z.object({
  seatId: z.number().int().positive(),
});

export const reservationRoutes = Router();

reservationRoutes.use(requireAuth);

// `?active=true` narrows to live holds and bookings; the default is the full history.
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

/**
 * Extend a running hold by one seat. The countdown is not extended with it - a
 * selection gets one 15 minute window, measured from its first seat.
 * 409 = someone took it first, 422 = the seat breaks a rule.
 */
reservationRoutes.post('/:reservationId/seats', async (req, res) => {
  const { reservationId } = reservationIdParam.parse(req.params);
  const { seatId } = seatBody.parse(req.body);
  const user = currentUser(req);
  res.json({ reservation: await addSeatToHold({ reservationId, userId: user.id, seatId }) });
});

/**
 * Give one seat back immediately. Releasing the last seat releases the reservation,
 * which comes back with status `cancelled`.
 */
reservationRoutes.delete('/:reservationId/seats/:seatId', async (req, res) => {
  const { reservationId, seatId } = seatParams.parse(req.params);
  const user = currentUser(req);
  res.json({ reservation: await removeSeatFromHold({ reservationId, userId: user.id, seatId }) });
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
