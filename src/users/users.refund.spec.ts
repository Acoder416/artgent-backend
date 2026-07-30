import { DataSource, Repository } from 'typeorm';
import { CreditTransaction } from './credit-transaction.entity';
import { User } from './user.entity';
import { UsersService } from './users.service';

describe('UsersService generation refunds', () => {
  it('restores the balance without counting a refund as earned credits', async () => {
    const user = Object.assign(new User(), {
      id: 9,
      credits: 17,
      totalCreditsEarned: 75,
      totalCreditsSpent: 21,
      role: 'user',
    });
    const repository = {
      findOne: () => Promise.resolve(user),
      save: (candidate: User) => Promise.resolve(candidate),
    } as unknown as Repository<User>;
    const service = new UsersService(repository);

    await service.addCredits(9, 1, 'refund', '生成失败退还 1 积分');

    expect(user.credits).toBe(18);
    expect(user.totalCreditsEarned).toBe(75);
    expect(user.totalCreditsSpent).toBe(20);
  });
  it('applies the same generation refund reference only once', async () => {
    const user = Object.assign(new User(), {
      id: 10,
      credits: 4,
      totalCreditsEarned: 20,
      totalCreditsSpent: 6,
      role: 'user',
    });
    const transactions: CreditTransaction[] = [];
    const userRepository = {
      findOne: () => Promise.resolve(user),
      save: (candidate: User) => Promise.resolve(candidate),
    } as unknown as Repository<User>;
    const manager = {
      findOne: jest.fn(
        (
          entity: typeof User | typeof CreditTransaction,
          options: {
            where: {
              userId?: number;
              type?: string;
              referenceId?: string;
            };
          },
        ) => {
          if (entity === User) return Promise.resolve(user);
          return Promise.resolve(
            transactions.find(
              (transaction) =>
                transaction.userId === options.where.userId &&
                transaction.type === options.where.type &&
                transaction.referenceId === options.where.referenceId,
            ) || null,
          );
        },
      ),
      create: jest.fn(
        (
          _entity: typeof CreditTransaction,
          input: Partial<CreditTransaction>,
        ) => Object.assign(new CreditTransaction(), input),
      ),
      save: jest.fn(
        (
          entity: typeof User | typeof CreditTransaction,
          candidate: User | CreditTransaction,
        ) => {
          if (entity === CreditTransaction) {
            transactions.push(candidate as CreditTransaction);
          }
          return Promise.resolve(candidate);
        },
      ),
    };
    const dataSource = {
      transaction: <T>(
        callback: (transactionManager: typeof manager) => Promise<T>,
      ) => callback(manager),
    } as unknown as DataSource;
    const service = new UsersService(userRepository, undefined, dataSource);

    await service.refundCreditsOnce(10, 1, 'request-1:99');
    await service.refundCreditsOnce(10, 1, 'request-1:99');

    expect(user.credits).toBe(5);
    expect(user.totalCreditsSpent).toBe(5);
    expect(transactions).toHaveLength(1);
  });

  it('locks the user and records a generation charge in one transaction', async () => {
    const user = Object.assign(new User(), {
      id: 11,
      credits: 6,
      totalCreditsEarned: 20,
      totalCreditsSpent: 4,
      role: 'user',
    });
    const transactions: CreditTransaction[] = [];
    const manager = {
      findOne: jest.fn((entity: typeof User | typeof CreditTransaction) =>
        Promise.resolve(entity === User ? user : null),
      ),
      create: jest.fn(
        (
          _entity: typeof CreditTransaction,
          input: Partial<CreditTransaction>,
        ) => Object.assign(new CreditTransaction(), input),
      ),
      save: jest.fn(
        (
          entity: typeof User | typeof CreditTransaction,
          candidate: User | CreditTransaction,
        ) => {
          if (entity === CreditTransaction) {
            transactions.push(candidate as CreditTransaction);
          }
          return Promise.resolve(candidate);
        },
      ),
    };
    const dataSource = {
      transaction: <T>(
        callback: (transactionManager: typeof manager) => Promise<T>,
      ) => callback(manager),
    } as unknown as DataSource;
    const service = new UsersService(
      {
        findOne: jest.fn(),
        save: jest.fn(),
      } as unknown as Repository<User>,
      undefined,
      dataSource,
    );

    await service.deductCredits(11, 2, 'Generate 2 images', 'request-2');

    expect(manager.findOne).toHaveBeenCalledWith(User, {
      where: { id: 11 },
      lock: { mode: 'pessimistic_write' },
    });
    expect(user.credits).toBe(4);
    expect(user.totalCreditsSpent).toBe(6);
    expect(transactions).toEqual([
      expect.objectContaining({
        userId: 11,
        type: 'generation',
        amount: -2,
        balanceAfter: 4,
        referenceId: 'request-2',
      }),
    ]);
  });
});
