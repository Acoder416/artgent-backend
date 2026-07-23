import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';

function createUserRepository(): Repository<User> {
  const users: User[] = [];

  return {
    findOne: ({ where }: { where: Partial<User> }) =>
      Promise.resolve(
        users.find((user) =>
          Object.entries(where).every(
            ([key, value]) => user[key as keyof User] === value,
          ),
        ) ?? null,
      ),
    create: (input: Partial<User>) => Object.assign(new User(), input),
    save: (user: User) => {
      if (!user.id) {
        user.id = users.length + 1;
        users.push(user);
      }
      return Promise.resolve(user);
    },
  } as unknown as Repository<User>;
}

describe('UsersService administrator initialization', () => {
  it('creates a configured administrator that can authenticate', async () => {
    const service = new UsersService(createUserRepository());

    await service.ensureAdminUser({
      username: 'admin',
      email: 'admin@artgen.local',
      password: 'generated-admin-password',
    });

    const administrator = await service.findByUsername('admin');
    expect(administrator?.role).toBe('admin');
    await expect(
      service.validatePassword(
        administrator as User,
        'generated-admin-password',
      ),
    ).resolves.toBe(true);
  });
});
