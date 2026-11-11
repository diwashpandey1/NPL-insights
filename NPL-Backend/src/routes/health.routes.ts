import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.status(200).json({ success: true, message: 'NPL Cricket Analytics API is running' });
});
