import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { LoginDto } from '../users/dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async register(createUserDto: CreateUserDto) {
    const user = await this.usersService.create(createUserDto);
    const token = this.generateToken(user);
    const userWithoutPassword = this.withoutPassword(user);
    return {
      user: userWithoutPassword,
      token,
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password, rememberMe } = loginDto;
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const isPasswordValid = await this.usersService.validatePassword(
      user,
      password,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const token = this.generateToken(user, rememberMe);
    const userWithoutPassword = this.withoutPassword(user);
    return {
      user: userWithoutPassword,
      token,
    };
  }

  private withoutPassword(user: User): Omit<User, 'passwordHash'> {
    const userWithoutPassword = { ...user };
    Reflect.deleteProperty(userWithoutPassword, 'passwordHash');
    return userWithoutPassword;
  }

  private generateToken(
    user: Pick<User, 'id' | 'username' | 'email'>,
    rememberMe = false,
  ): string {
    const payload = {
      sub: user.id,
      username: user.username,
      email: user.email,
    };
    if (rememberMe) {
      return this.jwtService.sign(payload, { expiresIn: '7d' });
    }
    return this.jwtService.sign(payload);
  }
}
