import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';

function createRepositoryWithUser(user: User): Repository<User> {
  const users = [user];

  return {
    findOne: ({ where }: { where: Partial<User> }) =>
      Promise.resolve(
        users.find((candidate) =>
          Object.entries(where).every(
            ([key, value]) => candidate[key as keyof User] === value,
          ),
        ) ?? null,
      ),
    create: (input: Partial<User>) => Object.assign(new User(), input),
    save: (candidate: User) => {
      if (!candidate.id) {
        candidate.id = users.length + 1;
        users.push(candidate);
      }
      return Promise.resolve(candidate);
    },
  } as unknown as Repository<User>;
}

describe('UsersService administrator initialization on restart', () => {
  it('promotes the existing configured user without changing its password', async () => {
    const existingUser = Object.assign(new User(), {
      id: 1,
      username: 'admin',
      email: 'admin@artgen.local',
      passwordHash: await bcrypt.hash('existing-password', 10),
      credits: 0,
      role: 'user',
    });
    const service = new UsersService(createRepositoryWithUser(existingUser));

    await service.ensureAdminUser({
      username: 'admin',
      email: 'admin@artgen.local',
      password: 'new-bootstrap-password',
    });

    const administrator = await service.findByUsername('admin');
    expect(administrator?.role).toBe('admin');
    await expect(
      service.validatePassword(administrator as User, 'existing-password'),
    ).resolves.toBe(true);
  });
});
