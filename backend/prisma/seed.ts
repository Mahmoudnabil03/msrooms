import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
const run = async () => { const passwordHash = await bcrypt.hash('demo-password', 12); const host = await prisma.user.upsert({ where:{username:'maya'}, update:{}, create:{username:'maya',email:'maya@example.com',passwordHash,isVerified:true,bio:'soft sounds for the insomniacs & dreamers'} }); await prisma.room.create({ data:{name:'Late Night Frequencies',category:'Music',hostId:host.id,participants:{create:{userId:host.id,role:'HOST'}}} }).catch(()=>undefined); }; run().finally(()=>prisma.$disconnect());
