import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

@Entity('images')
export class Image {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @Column('text')
  prompt: string;

  @Column({ length: 100, default: 'gpt-image-1' })
  model: string;

  @Column({ length: 500, name: 'image_url', nullable: true })
  imageUrl: string;

  @Column({ length: 500, name: 'image_key', nullable: true })
  imageKey: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'generating', 'completed', 'failed'],
    default: 'pending',
  })
  status: string;

  @Column('text', { name: 'error_message', nullable: true })
  errorMessage: string;

  @Column({ default: 1024 })
  width: number;

  @Column({ default: 1024 })
  height: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => User, (user) => user.images)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
