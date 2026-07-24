import { Repository } from 'typeorm';
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
});
