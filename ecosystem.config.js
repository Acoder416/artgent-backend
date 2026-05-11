module.exports = {
  apps: [
    {
      name: 'artgen-backend',
      script: 'dist/main.js',
      cwd: '/root/projects/artgen/backend',
      env: {
        NODE_ENV: 'development',
        PORT: 3001,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/root/projects/artgen/backend/logs/error.log',
      out_file: '/root/projects/artgen/backend/logs/out.log',
      merge_logs: true,
    },
  ],
};
