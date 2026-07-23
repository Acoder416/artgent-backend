import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USERNAME || 'artgen',
  password: process.env.DB_PASSWORD || 'ArtGen@2026',
  database: process.env.DB_DATABASE || 'artgen',
}));

export const jwtConfig = registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET || '',
  expiresIn: process.env.JWT_EXPIRES_IN || '7d',
}));

export const minioConfig = registerAs('minio', () => ({
  endPoint: process.env.MINIO_ENDPOINT || 'static.lzljz.top',
  port: parseInt(process.env.MINIO_PORT || '443', 10),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || '',
  secretKey: process.env.MINIO_SECRET_KEY || '',
  bucket: process.env.MINIO_BUCKET || 'artgen',
  publicUrl: process.env.MINIO_PUBLIC_URL || '',
}));

export const sub2apiConfig = registerAs('sub2api', () => ({
  baseUrl: process.env.SUB2API_BASE_URL || 'http://127.0.0.1:9099',
  apiKey: process.env.SUB2API_KEY || '',
}));
