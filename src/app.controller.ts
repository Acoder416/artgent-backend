import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppService } from './app.service';
import type { AppEnvironment } from './bootstrap/environment';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  getHealth() {
    return {
      service: 'artgen-backend',
      status: 'ok',
      environment: this.configService.get<AppEnvironment>(
        'NODE_ENV',
        'development',
      ),
    };
  }
}
