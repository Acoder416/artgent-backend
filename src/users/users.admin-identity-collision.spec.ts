import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';

function createRepositoryWithUsers(users: User[]): Repository<User> {
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
    save: (candidate: User) => Promise.resolve(candidate),
  } as unknown as Repository<User>;
}

async function createUser(
  id: number,
  username: string,
  email: string,
): Promise<User> {
  return Object.assign(new User(), {
    id,
    username,
    email,
    passwordHash: await bcrypt.hash('existing-password', 10),
    credits: 0,
    role: 'user',
  });
}

describe('UsersService administrator identity collisions', () => {
  it('rejects a username and email that belong to different users', async () => {
    const usernameOwner = await createUser(
      1,
      'configured-owner',
      'first@example.com',
    );
    const emailOwner = await createUser(
      2,
      'different-owner',
      'configured@example.com',
    );
    const service = new UsersService(
      createRepositoryWithUsers([usernameOwner, emailOwner]),
    );

    await expect(
      service.ensureAdminUser({
        username: 'configured-owner',
        email: 'configured@example.com',
        password: 'bootstrap-password',
      }),
    ).rejects.toThrow(
      'Configured administrator username and email do not identify one account',
    );
    expect(usernameOwner.role).toBe('user');
    expect(emailOwner.role).toBe('user');
  });

  it('rejects an existing username paired with an unused email', async () => {
    const usernameOwner = await createUser(
      1,
      'configured-owner',
      'existing@example.com',
    );
    const service = new UsersService(
      createRepositoryWithUsers([usernameOwner]),
    );

    await expect(
      service.ensureAdminUser({
        username: 'configured-owner',
        email: 'configured@example.com',
        password: 'bootstrap-password',
      }),
    ).rejects.toThrow(
      'Configured administrator username and email do not identify one account',
    );
    expect(usernameOwner.role).toBe('user');
  });
});
