import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Image } from '../images/image.entity';
import { CreditTransaction } from './credit-transaction.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 50, unique: true })
  username: string;

  @Column({ length: 100, unique: true })
  email: string;

  @Column({ length: 255, name: 'password_hash' })
  passwordHash: string;

  @Column({ type: 'varchar', length: 500, name: 'avatar_url', nullable: true })
  avatarUrl: string | null;

  @Column({ default: 10 })
  credits: number;

  @Column({ name: 'total_credits_earned', default: 10 })
  totalCreditsEarned: number;

  @Column({ name: 'total_credits_spent', default: 0 })
  totalCreditsSpent: number;

  @Column({ name: 'consecutive_check_in_days', default: 0 })
  consecutiveCheckInDays: number;

  @Column({ type: 'datetime', name: 'last_check_in_at', nullable: true })
  lastCheckInAt: Date | null;

  @Column({ length: 20, default: 'user' })
  role: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => Image, (image) => image.user)
  images: Image[];

  @OneToMany(() => CreditTransaction, (transaction) => transaction.user)
  creditTransactions: CreditTransaction[];
}
