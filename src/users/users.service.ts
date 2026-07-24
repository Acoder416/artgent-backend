import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';
import { MinioService } from '../upload/minio.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  CreditTransaction,
  CreditTransactionType,
} from './credit-transaction.entity';
import { User } from './user.entity';

interface AdminUserConfig {
  username: string;
  email: string;
  password: string;
}

interface AvatarUpload {
  buffer: Buffer;
  mimetype?: string;
}

export interface CheckInResult {
  credits: number;
  creditsAwarded: number;
  bonusCredits: number;
  consecutiveDays: number;
  checkedInAt: Date;
}

type AvatarExtension = 'jpg' | 'png';

function detectAvatarExtension(buffer: Buffer): AvatarExtension | null {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    buffer.length >= pngSignature.length &&
    buffer.subarray(0, pngSignature.length).equals(pngSignature)
  ) {
    return 'png';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpg';
  }
  return null;
}

function isDuplicateEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const databaseError = error as {
    code?: string;
    errno?: number;
    driverError?: { code?: string; errno?: number };
  };
  return [databaseError, databaseError.driverError].some(
    (candidate) =>
      candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062,
  );
}

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

function shanghaiCalendarDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarDayDistance(previous: string, current: string): number {
  const [previousYear, previousMonth, previousDay] = previous
    .split('-')
    .map(Number);
  const [currentYear, currentMonth, currentDay] = current
    .split('-')
    .map(Number);
  return Math.round(
    (Date.UTC(currentYear, currentMonth - 1, currentDay) -
      Date.UTC(previousYear, previousMonth - 1, previousDay)) /
      86_400_000,
  );
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @Optional()
    @InjectRepository(CreditTransaction)
    private readonly creditsRepository?: Repository<CreditTransaction>,
    @Optional() private readonly dataSource?: DataSource,
    @Optional() private readonly minioService?: MinioService,
  ) {}

  async ensureAdminUser(config: AdminUserConfig): Promise<User> {
    const [userByUsername, userByEmail] = await Promise.all([
      this.findByUsername(config.username),
      this.findByEmail(config.email),
    ]);
    if (
      userByUsername &&
      (!userByEmail || userByUsername.id !== userByEmail.id)
    ) {
      throw new ConflictException(
        'Configured administrator username and email do not identify one account',
      );
    }
    if (userByEmail) {
      userByEmail.role = 'admin';
      return this.usersRepository.save(userByEmail);
    }
    const passwordHash = await bcrypt.hash(config.password, 10);
    return this.usersRepository.save(
      this.usersRepository.create({
        username: config.username,
        email: config.email,
        passwordHash,
        role: 'admin',
      }),
    );
  }

  async create({ username, email, password }: CreateUserDto): Promise<User> {
    if (username.toLowerCase() === 'admin') {
      throw new ConflictException('用户名已存在');
    }
    if (await this.usersRepository.findOne({ where: { username } })) {
      throw new ConflictException('用户名已存在');
    }
    if (await this.usersRepository.findOne({ where: { email } })) {
      throw new ConflictException('邮箱已被注册');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    return this.usersRepository.save(
      this.usersRepository.create({
        username,
        email,
        passwordHash,
        role: 'user',
      }),
    );
  }

  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  findByUsername(username: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { username } });
  }

  findById(id: number): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  validatePassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }

  async updateProfile(
    userId: number,
    dto: UpdateProfileDto,
    avatar?: AvatarUpload,
  ) {
    const user = await this.requireUser(userId);
    const username = dto.username.trim();
    if (username.toLowerCase() === 'admin' && user.role !== 'admin') {
      throw new ConflictException('用户名已存在');
    }
    if (username !== user.username) {
      const existingUser = await this.findByUsername(username);
      if (existingUser && existingUser.id !== user.id) {
        throw new ConflictException('用户名已存在');
      }
      user.username = username;
    }

    const previousAvatarUrl = user.avatarUrl;
    let uploadedAvatarUrl: string | null = null;

    if (avatar) {
      const extension = detectAvatarExtension(avatar.buffer);
      const expectedMimeType =
        extension === 'png'
          ? 'image/png'
          : extension === 'jpg'
            ? 'image/jpeg'
            : null;
      if (!extension || avatar.mimetype !== expectedMimeType) {
        throw new BadRequestException('头像仅支持 JPG、PNG 格式');
      }
      if (!this.minioService) {
        throw new Error('Image storage is unavailable');
      }
      uploadedAvatarUrl = await this.minioService.uploadImage(
        avatar.buffer,
        user.id,
        extension,
      );
      user.avatarUrl = uploadedAvatarUrl;
    } else if (dto.removeAvatar) {
      user.avatarUrl = null;
    }

    let savedUser: User;
    try {
      savedUser = await this.usersRepository.save(user);
    } catch (error: unknown) {
      if (uploadedAvatarUrl && this.minioService) {
        await this.minioService.deleteImageByUrl(uploadedAvatarUrl);
      }
      if (isDuplicateEntryError(error)) {
        throw new ConflictException('用户名已存在');
      }
      throw error;
    }

    if (
      previousAvatarUrl &&
      previousAvatarUrl !== savedUser.avatarUrl &&
      this.minioService
    ) {
      await this.minioService.deleteImageByUrl(previousAvatarUrl);
    }
    return this.serializeProfile(savedUser);
  }

  async deductCredits(
    userId: number,
    amount = 1,
    description = '图片生成',
    referenceId?: string,
  ): Promise<User> {
    const user = await this.requireUser(userId);
    if (user.role === 'admin') return user;
    if (user.credits < amount) throw new ConflictException('积分不足');
    user.credits -= amount;
    user.totalCreditsSpent = (user.totalCreditsSpent || 0) + amount;
    const saved = await this.usersRepository.save(user);
    await this.recordCredit(
      saved,
      'generation',
      -amount,
      description,
      referenceId,
    );
    return saved;
  }

  async addCredits(
    userId: number,
    amount = 1,
    type: CreditTransactionType = 'refund',
    description = '生成失败退还',
    referenceId?: string,
  ): Promise<User> {
    const user = await this.requireUser(userId);
    if (user.role === 'admin') return user;
    user.credits += amount;
    if (type === 'refund') {
      user.totalCreditsSpent = Math.max(
        0,
        (user.totalCreditsSpent || 0) - amount,
      );
    } else {
      user.totalCreditsEarned = (user.totalCreditsEarned || 0) + amount;
    }
    const saved = await this.usersRepository.save(user);
    await this.recordCredit(saved, type, amount, description, referenceId);
    return saved;
  }

  async checkIn(userId: number, now = new Date()): Promise<CheckInResult> {
    if (!this.dataSource) throw new Error('Database is unavailable');
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('用户不存在');
      if (user.role === 'admin') {
        return {
          credits: user.credits,
          creditsAwarded: 0,
          bonusCredits: 0,
          consecutiveDays: user.consecutiveCheckInDays || 0,
          checkedInAt: now,
        };
      }
      const today = shanghaiCalendarDay(now);
      const lastDay = user.lastCheckInAt
        ? shanghaiCalendarDay(new Date(user.lastCheckInAt))
        : null;
      if (lastDay === today) throw new ConflictException('今天已经签到');
      const consecutiveDays =
        lastDay && calendarDayDistance(lastDay, today) === 1
          ? (user.consecutiveCheckInDays || 0) + 1
          : 1;
      const bonusCredits = consecutiveDays % 7 === 0 ? 30 : 0;
      const creditsAwarded = 10 + bonusCredits;
      user.credits += creditsAwarded;
      user.totalCreditsEarned = (user.totalCreditsEarned || 0) + creditsAwarded;
      user.consecutiveCheckInDays = consecutiveDays;
      user.lastCheckInAt = now;
      await manager.save(User, user);
      await manager.save(
        CreditTransaction,
        manager.create(CreditTransaction, {
          userId,
          type: 'check_in',
          amount: 10,
          balanceAfter: user.credits - bonusCredits,
          description: '每日签到',
          referenceId: today,
        }),
      );
      if (bonusCredits) {
        await manager.save(
          CreditTransaction,
          manager.create(CreditTransaction, {
            userId,
            type: 'streak_bonus',
            amount: bonusCredits,
            balanceAfter: user.credits,
            description: `连续签到 ${consecutiveDays} 天奖励`,
            referenceId: today,
          }),
        );
      }
      return {
        credits: user.credits,
        creditsAwarded,
        bonusCredits,
        consecutiveDays,
        checkedInAt: now,
      };
    });
  }

  async getProfile(userId: number) {
    return this.serializeProfile(await this.requireUser(userId));
  }

  async getCreditTransactions(userId: number, page = 1, limit = 20) {
    await this.requireUser(userId);
    if (!this.creditsRepository) return { transactions: [], total: 0 };
    const [transactions, total] = await this.creditsRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { transactions, total };
  }

  private serializeProfile(user: User) {
    const { passwordHash, ...profile } = user;
    void passwordHash;
    return {
      ...profile,
      checkedInToday:
        !!user.lastCheckInAt &&
        shanghaiCalendarDay(new Date(user.lastCheckInAt)) ===
          shanghaiCalendarDay(new Date()),
    };
  }

  private async requireUser(userId: number): Promise<User> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  private async recordCredit(
    user: User,
    type: CreditTransactionType,
    amount: number,
    description: string,
    referenceId?: string,
  ) {
    if (!this.creditsRepository) return;
    await this.creditsRepository.save(
      this.creditsRepository.create({
        userId: user.id,
        type,
        amount,
        balanceAfter: user.credits,
        description,
        referenceId: referenceId || null,
      }),
    );
  }
}
