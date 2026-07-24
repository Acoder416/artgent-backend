import { BadRequestException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MinioService } from '../upload/minio.service';
import { User } from './user.entity';
import { UsersService } from './users.service';

function createRepository(users: User[]): Repository<User> {
  return {
    findOne: ({ where }: { where: Partial<User> }) =>
      Promise.resolve(
        users.find((user) =>
          Object.entries(where).every(
            ([key, value]) => user[key as keyof User] === value,
          ),
        ) ?? null,
      ),
    save: (user: User) => Promise.resolve(user),
  } as unknown as Repository<User>;
}

function createUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 1,
    username: 'creator',
    email: 'creator@example.com',
    passwordHash: 'secret',
    avatarUrl: null,
    credits: 10,
    totalCreditsEarned: 10,
    totalCreditsSpent: 0,
    consecutiveCheckInDays: 0,
    lastCheckInAt: null,
    role: 'user',
    ...overrides,
  });
}

describe('UsersService profile updates', () => {
  it('updates the username without exposing the password hash', async () => {
    const user = createUser();
    const service = new UsersService(createRepository([user]));

    const profile = await service.updateProfile(user.id, {
      username: 'new_creator',
    });

    expect(user.username).toBe('new_creator');
    expect(profile).toMatchObject({ username: 'new_creator' });
    expect(profile).not.toHaveProperty('passwordHash');
  });

  it('reserves the admin username for administrator accounts', async () => {
    const user = createUser();
    const service = new UsersService(createRepository([user]));

    await expect(
      service.updateProfile(user.id, { username: 'ADMIN' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows an administrator to use the reserved admin username', async () => {
    const user = createUser({ username: 'owner', role: 'admin' });
    const service = new UsersService(createRepository([user]));

    const profile = await service.updateProfile(user.id, {
      username: 'admin',
    });

    expect(profile.username).toBe('admin');
  });

  it('rejects a username owned by another account', async () => {
    const user = createUser();
    const other = createUser({ id: 2, username: 'taken' });
    const service = new UsersService(createRepository([user, other]));

    await expect(
      service.updateProfile(user.id, { username: 'taken' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('uploads and stores a supported avatar image', async () => {
    const user = createUser();
    const minioService = {
      uploadImage: jest.fn().mockResolvedValue('https://cdn.test/avatar.jpg'),
      deleteImageByUrl: jest.fn(),
    } as unknown as MinioService;
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const service = new UsersService(
      createRepository([user]),
      undefined,
      undefined,
      minioService,
    );

    const profile = await service.updateProfile(
      user.id,
      { username: user.username },
      { buffer: jpegBuffer, mimetype: 'image/jpeg' },
    );

    expect(minioService.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      user.id,
      'jpg',
    );
    expect(profile.avatarUrl).toBe('https://cdn.test/avatar.jpg');
  });

  it('rejects unsupported avatar formats', async () => {
    const user = createUser();
    const minioService = {
      uploadImage: jest.fn(),
    } as unknown as MinioService;
    const service = new UsersService(
      createRepository([user]),
      undefined,
      undefined,
      minioService,
    );

    await expect(
      service.updateProfile(
        user.id,
        { username: user.username },
        { buffer: Buffer.from('avatar'), mimetype: 'image/gif' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a file whose contents do not match its declared image type', async () => {
    const user = createUser();
    const minioService = {
      uploadImage: jest.fn(),
    } as unknown as MinioService;
    const service = new UsersService(
      createRepository([user]),
      undefined,
      undefined,
      minioService,
    );

    await expect(
      service.updateProfile(
        user.id,
        { username: user.username },
        { buffer: Buffer.from('not an image'), mimetype: 'image/jpeg' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes the current avatar when requested', async () => {
    const user = createUser({ avatarUrl: 'https://cdn.test/avatar.png' });
    const minioService = {
      deleteImageByUrl: jest.fn(),
    } as unknown as MinioService;
    const service = new UsersService(
      createRepository([user]),
      undefined,
      undefined,
      minioService,
    );

    const profile = await service.updateProfile(user.id, {
      username: user.username,
      removeAvatar: true,
    });

    expect(profile.avatarUrl).toBeNull();
    expect(minioService.deleteImageByUrl).toHaveBeenCalledWith(
      'https://cdn.test/avatar.png',
    );
  });

  it('deletes the previous object after replacing an avatar', async () => {
    const user = createUser({ avatarUrl: 'https://cdn.test/old-avatar.jpg' });
    const minioService = {
      uploadImage: jest
        .fn()
        .mockResolvedValue('https://cdn.test/new-avatar.jpg'),
      deleteImageByUrl: jest.fn(),
    } as unknown as MinioService;
    const service = new UsersService(
      createRepository([user]),
      undefined,
      undefined,
      minioService,
    );

    await service.updateProfile(
      user.id,
      { username: user.username },
      {
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
        mimetype: 'image/jpeg',
      },
    );

    expect(minioService.deleteImageByUrl).toHaveBeenCalledWith(
      'https://cdn.test/old-avatar.jpg',
    );
  });

  it('deletes a newly uploaded object when the database save fails', async () => {
    const user = createUser();
    const repository = createRepository([user]);
    repository.save = jest
      .fn()
      .mockRejectedValue(
        new Error('database unavailable'),
      ) as Repository<User>['save'];
    const minioService = {
      uploadImage: jest
        .fn()
        .mockResolvedValue('https://cdn.test/new-avatar.jpg'),
      deleteImageByUrl: jest.fn(),
    } as unknown as MinioService;
    const service = new UsersService(
      repository,
      undefined,
      undefined,
      minioService,
    );

    await expect(
      service.updateProfile(
        user.id,
        { username: user.username },
        {
          buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
          mimetype: 'image/jpeg',
        },
      ),
    ).rejects.toThrow('database unavailable');
    expect(minioService.deleteImageByUrl).toHaveBeenCalledWith(
      'https://cdn.test/new-avatar.jpg',
    );
  });

  it('maps a database duplicate-key race to a username conflict', async () => {
    const user = createUser();
    const repository = createRepository([user]);
    repository.save = jest
      .fn()
      .mockRejectedValue({ code: 'ER_DUP_ENTRY' }) as Repository<User>['save'];
    const service = new UsersService(repository);

    await expect(
      service.updateProfile(user.id, { username: 'available_at_check_time' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
