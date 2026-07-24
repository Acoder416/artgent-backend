import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity';

@Entity('images')
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

  @Column({ length: 10, name: 'aspect_ratio', default: '1:1' })
  aspectRatio: string;

  @Column({ length: 10, default: '1K' })
  resolution: string;

  @Column({ type: 'varchar', length: 500, name: 'image_url', nullable: true })
  imageUrl: string | null;

  @Column({ type: 'varchar', length: 500, name: 'image_key', nullable: true })
  imageKey: string | null;

  @Column('simple-json', { name: 'reference_image_urls', nullable: true })
  referenceImageUrls: string[] | null;

  @Column({ type: 'enum', enum: ['pending', 'generating', 'completed', 'failed'], default: 'pending' })
  status: string;

  @Column('text', { name: 'error_message', nullable: true })
  errorMessage: string | null;

  @Column({ default: 1024 })
  width: number;

  @Column({ default: 1024 })
  height: number;

  @Column({ type: 'int', nullable: true })
  seed: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => User, (user) => user.images)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
