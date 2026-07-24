import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  getProfile(@Request() req) {
    return this.usersService.getProfile(req.user.id);
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('avatar', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  updateProfile(
    @Request() req,
    @Body(ValidationPipe) dto: UpdateProfileDto,
    @UploadedFile()
    avatar?: { buffer: Buffer; mimetype?: string; originalname?: string },
  ) {
    return this.usersService.updateProfile(req.user.id, dto, avatar);
  }

  @Post('check-in')
  @UseGuards(JwtAuthGuard)
  checkIn(@Request() req) {
    return this.usersService.checkIn(req.user.id);
  }

  @Get('credits/transactions')
  @UseGuards(JwtAuthGuard)
  getCreditTransactions(
    @Request() req,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.usersService.getCreditTransactions(req.user.id, page, limit);
  }
}
