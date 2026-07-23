import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(
    request: Record<string, unknown>,
  ): Promise<string> {
    const body = request.body;
    if (typeof body === 'object' && body !== null && 'email' in body) {
      const email = body.email;
      if (typeof email === 'string' && email.trim().length > 0) {
        return `email:${email.trim().toLowerCase()}`;
      }
    }

    return super.getTracker(request);
  }
}
