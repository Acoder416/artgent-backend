import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface GenerateImageResult {
  success: boolean;
  imageBuffer?: Buffer;
  error?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private baseUrl: string;
  private apiKey: string;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get('SUB2API_BASE_URL', 'http://127.0.0.1:9099');
    this.apiKey = this.configService.get('SUB2API_KEY', '');
  }

  /**
   * 调用AI接口生成图片
   * TODO: 接入实际的图片生成API（sub2api 或 OpenAI）
   * 
   * @param prompt 用户输入的提示词
   * @param model 模型名称 (gpt-image-1 / dall-e-3)
   * @param size 图片尺寸
   * @returns 图片Buffer
   */
  async generateImage(
    prompt: string,
    model: string = 'gpt-image-1',
    size: string = '1024x1024',
  ): Promise<GenerateImageResult> {
    this.logger.log(`Generating image: model=${model}, prompt="${prompt.slice(0, 50)}..."`);

    try {
      // TODO: 替换为实际的图片生成API调用
      // 示例：OpenAI Images API
      // const response = await axios.post(
      //   `${this.baseUrl}/v1/images/generations`,
      //   {
      //     model,
      //     prompt,
      //     n: 1,
      //     size,
      //     response_format: 'b64_json',
      //   },
      //   {
      //     headers: {
      //       'Authorization': `Bearer ${this.apiKey}`,
      //       'Content-Type': 'application/json',
      //     },
      //     timeout: 120000, // 2分钟超时
      //   },
      // );
      // const imageBase64 = response.data.data[0].b64_json;
      // return {
      //   success: true,
      //   imageBuffer: Buffer.from(imageBase64, 'base64'),
      // };

      // 临时：返回错误提示，等待接入实际API
      return {
        success: false,
        error: '图片生成API尚未接入，请联系管理员配置',
      };
    } catch (error) {
      this.logger.error(`Image generation failed: ${error.message}`);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message || '图片生成失败',
      };
    }
  }
}
