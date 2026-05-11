import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Query,
  UseGuards,
  Request,
  ValidationPipe,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ImagesService } from './images.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateImageDto } from './dto/create-image.dto';

@Controller('images')
@UseGuards(JwtAuthGuard)
export class ImagesController {
  constructor(private readonly imagesService: ImagesService) {}

  @Post('generate')
  async generate(@Request() req, @Body(ValidationPipe) createImageDto: CreateImageDto) {
    return this.imagesService.generate(
      req.user.id,
      createImageDto.prompt,
      createImageDto.model,
    );
  }

  @Get()
  async findAll(
    @Request() req,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
  ) {
    return this.imagesService.findByUserId(req.user.id, page, limit);
  }

  @Get(':id')
  async findOne(@Request() req, @Param('id', ParseIntPipe) id: number) {
    const image = await this.imagesService.findById(id);
    if (!image || image.userId !== req.user.id) {
      return null;
    }
    return image;
  }

  @Delete(':id')
  async remove(@Request() req, @Param('id', ParseIntPipe) id: number) {
    await this.imagesService.deleteImage(id, req.user.id);
    return { message: '图片已删除' };
  }
}
