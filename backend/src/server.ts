import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { Server } from 'socket.io';
import { PrismaClient, RoomRole } from '@prisma/client';
import { RtcRole, RtcTokenBuilder } from 'agora-access-token';
import { z } from 'zod';

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN === '*' ? true : process.env.CLIENT_ORIGIN } });
const secret = process.env.JWT_SECRET || 'development-only-secret';
const port = Number(process.env.PORT || 4000);
const redis = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL }) : null;
redis?.on('error', error => console.error('Redis:', error.message));
redis?.connect().catch(error => console.warn('Redis unavailable:', error.message));

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN === '*' ? true : process.env.CLIENT_ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

type AuthRequest = Request & { userId?: string };
const userSelect = { id: true, username: true, email: true, phone: true, avatarUrl: true, bio: true, isVerified: true } as const;
const accessToken = (userId: string) => jwt.sign({ sub: userId }, secret, { expiresIn: '15m' });
const refreshToken = (userId: string) => jwt.sign({ sub: userId, type: 'refresh' }, secret, { expiresIn: '30d' });

const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!raw) throw new Error('missing token');
    const payload = jwt.verify(raw, secret) as { sub: string };
    req.userId = payload.sub;
    next();
  } catch { res.status(401).json({ error: 'Authentication required' }); }
};

const roomMember = async (roomId: string, userId: string) => prisma.roomParticipant.findUnique({ where: { roomId_userId: { roomId, userId } } });
const sha = (value: string) => crypto.createHash('sha256').update(value + secret).digest('hex');

app.get('/health', (_, res) => res.json({ ok: true, service: 'ms-rooms-api' }));

app.post('/auth/otp/request', async (req, res) => {
  const parsed = z.object({ destination: z.string().min(5) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A valid email or phone is required' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.otpCode.deleteMany({ where: { destination: parsed.data.destination } });
  await prisma.otpCode.create({ data: { destination: parsed.data.destination, codeHash: sha(code), expiresAt: new Date(Date.now() + 10 * 60_000) } });
  console.log(`[OTP development delivery] ${parsed.data.destination}: ${code}`);
  return res.status(202).json({ message: 'Verification code sent' });
});

app.post('/auth/otp/verify', async (req, res) => {
  const parsed = z.object({ destination: z.string().min(5), code: z.string().length(6), username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid verification data' });
  const record = await prisma.otpCode.findFirst({ where: { destination: parsed.data.destination, expiresAt: { gt: new Date() } } });
  if (!record || record.codeHash !== sha(parsed.data.code)) return res.status(401).json({ error: 'Invalid or expired verification code' });
  const email = parsed.data.destination.includes('@') ? parsed.data.destination.toLowerCase() : undefined;
  const phone = email ? undefined : parsed.data.destination;
  let user = await prisma.user.findFirst({ where: email ? { email } : { phone } });
  if (!user) user = await prisma.user.create({ data: { email, phone, username: parsed.data.username || `user_${crypto.randomBytes(4).toString('hex')}`, passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12), isVerified: true } });
  else if (!user.isVerified) user = await prisma.user.update({ where: { id: user.id }, data: { isVerified: true } });
  await prisma.otpCode.delete({ where: { id: record.id } });
  return res.json({ user: await prisma.user.findUnique({ where: { id: user.id }, select: userSelect }), accessToken: accessToken(user.id), refreshToken: refreshToken(user.id) });
});

app.post('/auth/register', async (req, res) => {
  const parsed = z.object({ identifier: z.string().min(5), username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/), password: z.string().min(8) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid registration data' });
  const email = parsed.data.identifier.includes('@') ? parsed.data.identifier.toLowerCase() : undefined;
  const phone = email ? undefined : parsed.data.identifier;
  try { const user = await prisma.user.create({ data: { email, phone, username: parsed.data.username, passwordHash: await bcrypt.hash(parsed.data.password, 12) } }); return res.status(201).json({ user: await prisma.user.findUnique({ where: { id: user.id }, select: userSelect }), accessToken: accessToken(user.id), refreshToken: refreshToken(user.id) }); }
  catch { return res.status(409).json({ error: 'Email, phone, or username already exists' }); }
});

app.post('/auth/login', async (req, res) => {
  const parsed = z.object({ identifier: z.string(), password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid login data' });
  const identifier = parsed.data.identifier.includes('@') ? parsed.data.identifier.toLowerCase() : parsed.data.identifier;
  const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }, { username: parsed.data.identifier }] } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  return res.json({ user: await prisma.user.findUnique({ where: { id: user.id }, select: userSelect }), accessToken: accessToken(user.id), refreshToken: refreshToken(user.id) });
});

app.post('/auth/refresh', (req, res) => { try { const payload = jwt.verify(req.body.refreshToken, secret) as { sub: string; type: string }; if (payload.type !== 'refresh') throw new Error(); return res.json({ accessToken: accessToken(payload.sub) }); } catch { return res.status(401).json({ error: 'Invalid refresh token' }); } });
app.get('/users/me', requireAuth, async (req: AuthRequest, res) => res.json(await prisma.user.findUnique({ where: { id: req.userId }, select: userSelect })));
app.patch('/users/me', requireAuth, async (req: AuthRequest, res) => { const parsed = z.object({ username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/).optional(), bio: z.string().max(160).optional(), avatarUrl: z.string().url().nullable().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid profile data' }); try { return res.json(await prisma.user.update({ where: { id: req.userId }, data: parsed.data, select: userSelect })); } catch { return res.status(409).json({ error: 'Username already in use' }); } });

app.get('/rooms', async (req, res) => { const category = typeof req.query.category === 'string' ? req.query.category : undefined; const rooms = await prisma.room.findMany({ where: { isActive: true, isPrivate: false, ...(category ? { category } : {}) }, include: { host: { select: { id: true, username: true, avatarUrl: true } }, participants: { where: { status: 'ACTIVE' }, select: { id: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json(rooms.map(({ participants, ...room }) => ({ ...room, participantCount: participants.length }))); });
app.post('/rooms', requireAuth, async (req: AuthRequest, res) => { const parsed = z.object({ name: z.string().min(2).max(80), category: z.string().min(2).max(40), isPrivate: z.boolean().default(false), maxParticipants: z.number().int().min(2).max(1000).default(100) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid room data' }); const room = await prisma.room.create({ data: { ...parsed.data, hostId: req.userId!, participants: { create: { userId: req.userId!, role: 'HOST' } } }, include: { host: { select: { id: true, username: true, avatarUrl: true } } } }); return res.status(201).json(room); });
app.get('/rooms/:id', async (req, res) => { const room = await prisma.room.findUnique({ where: { id: req.params.id }, include: { host: { select: { id: true, username: true, avatarUrl: true } }, participants: { where: { status: 'ACTIVE' }, include: { user: { select: userSelect } } }, messages: { orderBy: { createdAt: 'desc' }, take: 50, include: { user: { select: { username: true, avatarUrl: true } } } } } }); if (!room) return res.status(404).json({ error: 'Room not found' }); return res.json(room); });
app.post('/rooms/:id/agora-token', requireAuth, async (req: AuthRequest, res) => { const appId = process.env.AGORA_APP_ID; const certificate = process.env.AGORA_APP_CERTIFICATE; if (!appId || !certificate) return res.status(503).json({ error: 'Agora is not configured' }); const member = await roomMember(req.params.id, req.userId!); if (!member || member.status !== 'ACTIVE') return res.status(403).json({ error: 'Join the room first' }); const uid = Number.parseInt(req.userId!.slice(-8), 36) % 2147483647; const role = member.role === 'LISTENER' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER; const token = RtcTokenBuilder.buildTokenWithUid(appId, certificate, req.params.id, uid, role, Math.floor(Date.now() / 1000) + 3600); return res.json({ appId, channel: req.params.id, token, uid, role: member.role }); });

io.use((socket, next) => { try { const payload = jwt.verify(socket.handshake.auth?.token, secret) as { sub: string }; socket.data.userId = payload.sub; next(); } catch { next(new Error('unauthorized')); } });
io.on('connection', socket => {
  socket.on('room:join', async ({ roomId }, ack) => { try { const room = await prisma.room.findUnique({ where: { id: roomId } }); if (!room || !room.isActive) throw Error('Room unavailable'); const count = await prisma.roomParticipant.count({ where: { roomId, status: 'ACTIVE' } }); if (count >= room.maxParticipants) throw Error('Room is full'); const participant = await prisma.roomParticipant.upsert({ where: { roomId_userId: { roomId, userId: socket.data.userId } }, create: { roomId, userId: socket.data.userId }, update: { status: 'ACTIVE', leftAt: null } }); socket.join(roomId); await redis?.sAdd(`room:${roomId}:online`, socket.data.userId); await redis?.expire(`room:${roomId}:online`, 90); const state = await prisma.roomParticipant.findMany({ where: { roomId, status: 'ACTIVE' }, include: { user: { select: userSelect } } }); io.to(roomId).emit('room:participants', state); ack?.({ ok: true, participant }); } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not join' }); } });
  socket.on('room:leave', async ({ roomId }) => { const member = await roomMember(roomId, socket.data.userId); if (!member) return; await prisma.roomParticipant.update({ where: { id: member.id }, data: { status: 'LEFT', leftAt: new Date(), handRaised: false } }); await redis?.sRem(`room:${roomId}:online`, socket.data.userId); socket.leave(roomId); io.to(roomId).emit('room:user_left', { userId: socket.data.userId }); });
  socket.on('room:hand', async ({ roomId, raised }, ack) => { const member = await roomMember(roomId, socket.data.userId); if (!member || member.status !== 'ACTIVE') return ack?.({ ok: false, error: 'Join the room first' }); const updated = await prisma.roomParticipant.update({ where: { id: member.id }, data: { handRaised: Boolean(raised) } }); io.to(roomId).emit('room:hand', { userId: socket.data.userId, raised: updated.handRaised }); ack?.({ ok: true }); });
  socket.on('room:chat', async ({ roomId, body }, ack) => { const member = await roomMember(roomId, socket.data.userId); if (!member || member.status !== 'ACTIVE') return ack?.({ ok: false, error: 'Join the room first' }); if (typeof body !== 'string' || !body.trim() || body.length > 500) return ack?.({ ok: false, error: 'Invalid message' }); const message = await prisma.chatMessage.create({ data: { roomId, userId: socket.data.userId, body: body.trim() }, include: { user: { select: { username: true, avatarUrl: true } } } }); io.to(roomId).emit('room:chat', message); ack?.({ ok: true }); });
  socket.on('room:moderate', async ({ roomId, targetUserId, action }, ack) => { try { const host = await roomMember(roomId, socket.data.userId); if (host?.role !== 'HOST') throw Error('Only the host can moderate'); const target = await roomMember(roomId, targetUserId); if (!target || target.status !== 'ACTIVE') throw Error('Participant is not active'); const data = action === 'promote' ? { role: RoomRole.SPEAKER, handRaised: false } : action === 'demote' ? { role: RoomRole.LISTENER, isMuted: false } : action === 'mute' ? { isMuted: true } : action === 'unmute' ? { isMuted: false } : { status: 'REMOVED', leftAt: new Date(), handRaised: false }; const participant = await prisma.roomParticipant.update({ where: { id: target.id }, data, include: { user: { select: userSelect } } }); io.to(roomId).emit('room:moderated', { action, participant }); if (action === 'remove') io.to(roomId).emit('room:user_removed', { userId: targetUserId }); ack?.({ ok: true, participant }); } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Moderation failed' }); } });
  socket.on('game:start', async ({ roomId, type = 'quick-poll' }, ack) => { try { const host = await roomMember(roomId, socket.data.userId); if (host?.role !== 'HOST') throw Error('Only the host can start a game'); const participants = await prisma.roomParticipant.findMany({ where: { roomId, status: 'ACTIVE' }, select: { userId: true } }); const scores = Object.fromEntries(participants.map(p => [p.userId, 0])); const game = await prisma.gameSession.create({ data: { roomId, type, state: { prompt: 'What brings you into this room tonight?', options: ['Meet new people', 'Play a game', 'Hear a good story', 'Just listening'], answers: {} }, scores } }); io.to(roomId).emit('game:state', game); ack?.({ ok: true, game }); } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not start game' }); } });
  socket.on('game:answer', async ({ roomId, gameId, option }, ack) => { try { const member = await roomMember(roomId, socket.data.userId); if (!member || member.status !== 'ACTIVE') throw Error('Join the room first'); const game = await prisma.gameSession.findFirst({ where: { id: gameId, roomId, status: 'WAITING' } }); if (!game) throw Error('Game is no longer active'); const state = game.state as { prompt: string; options: string[]; answers: Record<string, string> }; if (!state.options.includes(option)) throw Error('Invalid answer'); const scores = game.scores as Record<string, number>; state.answers[socket.data.userId] = option; scores[socket.data.userId] = 1; const updated = await prisma.gameSession.update({ where: { id: game.id }, data: { state, scores }, }); io.to(roomId).emit('game:state', updated); ack?.({ ok: true }); } catch (error) { ack?.({ ok: false, error: error instanceof Error ? error.message : 'Could not answer' }); } });
});

app.use((_, res) => res.status(404).json({ error: 'Not found' }));
server.listen(port, () => console.log(`MS Rooms API listening on :${port}`));
