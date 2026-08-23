module.exports = {
  apps: [{
    name: "khatha-backend",
    script: "./index.js",
    instances: "max",
    exec_mode: "cluster",
    autorestart: true,
    watch: false,
    max_memory_restart: "512M",
    env_production: {
      NODE_ENV: "production"
    },
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 50000
  }]
}
