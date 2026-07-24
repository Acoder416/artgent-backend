import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity';

export type CreditTransactionType = 'registration' | 'check_in' | 'streak_bonus' | 'generation' | 'refund';

@Entity('credit_transactions')
@Index(['userId', 'createdAt'])
export class CreditTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ length: 30 })
  type: CreditTransactionType;

  @Column()
  amount: number;

  @Column({ name: 'balance_after' })
  balanceAfter: number;

  @Column({ length: 120 })
  description: string;

  @Column({ type: 'varchar', length: 64, name: 'reference_id', nullable: true })
  referenceId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => User, (user) => user.creditTransactions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
