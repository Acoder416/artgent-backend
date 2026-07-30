import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { AI_LINE_ID_MAX_LENGTH } from './ai-line';
import type { ImageJobInputReference } from './generation-input';

@Entity('images')
@Index('IDX_images_queue_available', ['status', 'availableAt', 'id'])
@Index('IDX_images_queue_lease', ['status', 'leaseExpiresAt'])
@Index('IDX_images_request_status', ['requestId', 'status'])
export class Image {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ type: 'varchar', length: 36, name: 'request_id', nullable: true })
  requestId: string | null;

  @Column('text')
  prompt: string;

  @Column({ length: 50, default: 'custom' })
  template: string;

  @Column({ length: 100, default: 'gpt-image-2' })
  model: string;

  @Column({
    length: AI_LINE_ID_MAX_LENGTH,
    name: 'line_id',
    default: 'line-a',
  })
  lineId: string;

  @Column({ length: 10, name: 'aspect_ratio', default: '1:1' })
  aspectRatio: string;

  @Column({ length: 10, default: '1K' })
  resolution: string;

  @Column({ type: 'varchar', length: 500, name: 'image_url', nullable: true })
  imageUrl: string | null;

  @Column({ type: 'varchar', length: 500, name: 'image_key', nullable: true })
  imageKey: string | null;

  @Column({ type: 'varchar', length: 100, name: 'mime_type', nullable: true })
  mimeType: string | null;

  @Column({ type: 'varchar', length: 16, name: 'image_format', nullable: true })
  imageFormat: string | null;

  @Column('simple-json', { name: 'reference_image_urls', nullable: true })
  referenceImageUrls: string[] | null;

  @Column('simple-json', { name: 'input_references', nullable: true })
  inputReferences: ImageJobInputReference[] | null;

  @Column({
    type: 'enum',
    enum: ['pending', 'generating', 'completed', 'failed'],
    default: 'pending',
  })
  status: string;

  @Column('text', { name: 'error_message', nullable: true })
  errorMessage: string | null;
  @Column({ type: 'int', name: 'job_version', default: 0 })
  jobVersion: number;

  @Column({ type: 'int', name: 'attempt_count', default: 0 })
  attemptCount: number;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'available_at',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  availableAt: Date;

  @Column({ type: 'varchar', length: 36, name: 'lease_token', nullable: true })
  leaseToken: string | null;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'lease_expires_at',
    nullable: true,
  })
  leaseExpiresAt: Date | null;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'started_at',
    nullable: true,
  })
  startedAt: Date | null;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'finished_at',
    nullable: true,
  })
  finishedAt: Date | null;

  @Column({
    type: 'datetime',
    precision: 6,
    name: 'refunded_at',
    nullable: true,
  })
  refundedAt: Date | null;

  @Column({ default: 1024 })
  width: number;

  @Column({ default: 1024 })
  height: number;

  @Column({ type: 'int', nullable: true })
  seed: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => User, (user) => user.images)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
