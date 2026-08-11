import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 10;
const MAX_TRACKERS = 10_000;

interface AuthenticatedRequest {
  ip?: string;
  user?: { id?: number | string };
}

@Injectable()
export class ImageGenerationThrottlerGuard implements CanActivate {
  private readonly requestsByTracker = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const tracker = this.tracker(request);
    const now = Date.now();
    const recent = (this.requestsByTracker.get(tracker) || []).filter(
      (timestamp) => timestamp > now - WINDOW_MS,
    );
    if (recent.length >= REQUEST_LIMIT) {
      throw new HttpException(
        'Too many image generation requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.requestsByTracker.set(tracker, recent);
    if (this.requestsByTracker.size > MAX_TRACKERS) this.prune(now);
    return true;
  }

  private tracker(request: AuthenticatedRequest): string {
    const id = request.user?.id;
    if (
      (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === 'string' && /^\d+$/.test(id))
    ) {
      return `user:${id}`;
    }
    return `ip:${request.ip || 'unknown'}`;
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    for (const [tracker, timestamps] of this.requestsByTracker) {
      if (timestamps.every((timestamp) => timestamp <= cutoff)) {
        this.requestsByTracker.delete(tracker);
      }
    }
  }
}
