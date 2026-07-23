module.exports = {
  apps: [
    {
      name: 'artgen-backend',
      script: 'dist/main.js',
      args: '--env=production',
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
