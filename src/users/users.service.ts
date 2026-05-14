import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    const { username, email, password } = createUserDto;

    // 检查用户名是否已存在
    const existingUsername = await this.usersRepository.findOne({
      where: { username },
    });
    if (existingUsername) {
      throw new ConflictException('用户名已存在');
    }

    // 检查邮箱是否已存在
    const existingEmail = await this.usersRepository.findOne({
      where: { email },
    });
    if (existingEmail) {
      throw new ConflictException('邮箱已被注册');
    }

    // 加密密码
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = this.usersRepository.create({
      username,
      email,
      passwordHash,
    });

    return this.usersRepository.save(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { username } });
  }

  async findById(id: number): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async validatePassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }

  async deductCredits(userId: number, amount: number = 1): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    // admin用户不扣积分
    if (user.username === 'admin') {
      return user;
    }
    if (user.credits < amount) {
      throw new ConflictException('积分不足');
    }
    user.credits -= amount;
    return this.usersRepository.save(user);
  }

  async addCredits(userId: number, amount: number = 1): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    // admin用户不加积分（已经是无限）
    if (user.username === 'admin') {
      return user;
    }
    user.credits += amount;
    return this.usersRepository.save(user);
  }

  async getProfile(userId: number) {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const { passwordHash, ...profile } = user;
    return profile;
  }

  // 刷新非管理员用户的积分（每天调用）
  async refreshCreditsForNonAdminUsers(): Promise<void> {
    const defaultCredits = 10;
    
    // 更新所有非管理员用户的积分为10
    await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({ credits: defaultCredits })
      .where('username != :username', { username: 'admin' })
      .execute();
    
    console.log(`[积分刷新] 已将非管理员用户积分刷新为 ${defaultCredits}`);
  }
}
