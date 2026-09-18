module.exports = {
  apps: [{
    name: "SelinaBot",
    script: "./src/index.ts",
    interpreter: "node",
    node_args: "--env-file=.env.selina --import=tsx",
    cwd: "C:\\Users\\Charles\\discord-claude-code-bot",
    env: {
      NODE_ENV: "production"
    }
  }]
}
