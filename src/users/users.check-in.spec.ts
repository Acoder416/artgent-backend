import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CreditTransaction } from './credit-transaction.entity';
import { User } from './user.entity';
import { UsersService } from './users.service';

function createCheckInHarness(lastCheckInAt?: Date, streak = 0) {
  const user = Object.assign(new User(), {
    id: 7,
    username: 'creator',
    email: 'creator@example.com',
    passwordHash: 'unused',
    role: 'user',
    credits: 100,
    totalCreditsEarned: 0,
    totalCreditsSpent: 0,
    consecutiveCheckInDays: streak,
    lastCheckInAt,
  });
  const transactions: CreditTransaction[] = [];
  const usersRepository = {
    findOne: () => Promise.resolve(user),
    save: (candidate: User) => Promise.resolve(candidate),
  } as unknown as Repository<User>;
  const creditsRepository = {
    findAndCount: () => Promise.resolve([transactions, transactions.length]),
  } as unknown as Repository<CreditTransaction>;
  const manager = {
    findOne: () => Promise.resolve(user),
    save: (_entity: unknown, candidate: User | CreditTransaction) => {
      if (candidate instanceof CreditTransaction) transactions.push(candidate);
      return Promise.resolve(candidate);
    },
    create: (_entity: unknown, input: Partial<CreditTransaction>) =>
      Object.assign(new CreditTransaction(), input),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: (work: (transactionManager: EntityManager) => unknown) =>
      work(manager),
  } as unknown as DataSource;

  return {
    service: new UsersService(usersRepository, creditsRepository, dataSource),
    user,
    transactions,
  };
}

describe('UsersService daily check-in', () => {
  it('adds 10 credits for a normal consecutive day', async () => {
    const { service, user, transactions } = createCheckInHarness(
      new Date('2026-07-22T03:00:00.000Z'),
      3,
    );

    const result = await service.checkIn(
      user.id,
      new Date('2026-07-23T03:00:00.000Z'),
    );

    expect(result).toMatchObject({
      creditsAwarded: 10,
      bonusCredits: 0,
      consecutiveDays: 4,
      credits: 110,
    });
    expect(transactions.map((item) => item.type)).toEqual(['check_in']);
  });

  it('adds an extra 30 credits on every seventh consecutive day', async () => {
    const { service, user, transactions } = createCheckInHarness(
      new Date('2026-07-22T03:00:00.000Z'),
      6,
    );

    const result = await service.checkIn(
      user.id,
      new Date('2026-07-23T03:00:00.000Z'),
    );

    expect(result).toMatchObject({
      creditsAwarded: 40,
      bonusCredits: 30,
      consecutiveDays: 7,
      credits: 140,
    });
    expect(transactions.map((item) => [item.type, item.amount])).toEqual([
      ['check_in', 10],
      ['streak_bonus', 30],
    ]);
  });

  it('rejects a second check-in on the same Shanghai calendar day', async () => {
    const { service, user } = createCheckInHarness(
      new Date('2026-07-23T01:00:00.000Z'),
      1,
    );

    await expect(
      service.checkIn(user.id, new Date('2026-07-23T15:00:00.000Z')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('restarts the streak after a missed Shanghai calendar day', async () => {
    const { service, user } = createCheckInHarness(
      new Date('2026-07-20T03:00:00.000Z'),
      5,
    );

    const result = await service.checkIn(
      user.id,
      new Date('2026-07-23T03:00:00.000Z'),
    );

    expect(result).toMatchObject({ consecutiveDays: 1, creditsAwarded: 10 });
  });
});
