import { DataSource } from 'typeorm';
import { Image } from '../images/image.entity';
import { CreditTransaction } from '../users/credit-transaction.entity';
import { User } from '../users/user.entity';

describe('MySQL entity metadata', () => {
  it('builds all application entity metadata without unsupported inferred types', async () => {
    const dataSource = new DataSource({
      type: 'mysql',
      host: 'localhost',
      username: 'unused',
      password: 'unused',
      database: 'unused',
      entities: [User, Image, CreditTransaction],
    });

    await expect(
      (
        dataSource as DataSource & {
          buildMetadatas(): Promise<void>;
        }
      ).buildMetadatas(),
    ).resolves.toBeUndefined();
  });
});
