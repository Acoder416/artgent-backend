module.exports = {
  apps: [{
    name: 'artgen-backend',
    script: 'dist/main.js',
    env_production: {
      NODE_ENV: 'production',
      PORT: '3001',
      DB_HOST: '127.0.0.1',
      DB_PORT: '3306',
      DB_USERNAME: 'artgen',
      DB_PASSWORD: 'ArtGen@2026',
      DB_DATABASE: 'artgen',
      JWT_SECRET: 'artgen_jwt_secret_2026_xxxxx',
      JWT_EXPIRES_IN: '7d',
      MINIO_ENDPOINT: 'static.lzljz.top',
      MINIO_PORT: '443',
      MINIO_USE_SSL: 'true',
      MINIO_ACCESS_KEY: 'minio_mCCDTH',
      MINIO_SECRET_KEY: '12345678',
      MINIO_BUCKET: 'artgen',
      MINIO_PUBLIC_URL: 'https://static.lzljz.top/artgen',
      SUB2API_BASE_URL: 'http://47.254.215.16:9099',
      SUB2API_KEY: 'sk-d9d78813249095b16b73b33f115788e826fb11b5d28623248615fd15d7264356',
      FRONTEND_URL: 'https://image.lzljz.top'
    }
  }]
};
