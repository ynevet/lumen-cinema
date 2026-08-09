import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { AppError } from '../errors.js';
import { findUserById, login, register } from '../services/authService.js';

const credentialsSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

const registrationSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(254),
  displayName: z.string().trim().min(2, 'Name must be at least 2 characters.').max(80),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    .max(128, 'Password must be at most 128 characters.'),
});

export const authRoutes = Router();

authRoutes.post('/register', async (req, res) => {
  const input = registrationSchema.parse(req.body);
  const result = await register(input);
  res.status(201).json(result);
});

authRoutes.post('/login', async (req, res) => {
  const input = credentialsSchema.parse(req.body);
  const result = await login(input);
  res.json(result);
});

/** Lets the client validate a stored token on boot and refresh the profile. */
authRoutes.get('/me', requireAuth, async (req, res) => {
  const { id } = currentUser(req);
  const user = await findUserById(id);
  if (!user) {
    throw AppError.unauthorized('Your account no longer exists.', 'USER_NOT_FOUND');
  }
  res.json({ user });
});
