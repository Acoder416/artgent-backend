import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UsersService } from './users.service';

@Injectable()
export class CreditRefreshService {
  private readonly logger = new Logger(CreditRefreshService.name);

  constructor(private readonly usersService: UsersService) {}

  // 每天凌晨0点刷新积分
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCreditRefresh() {
    this.logger.log('开始执行每日积分刷新任务...');
    try {
      await this.usersService.refreshCreditsForNonAdminUsers();
      this.logger.log('积分刷新任务完成');
    } catch (error) {
      this.logger.error('积分刷新任务失败', error);
    }
  }
}
